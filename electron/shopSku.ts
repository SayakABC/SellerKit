// electron/shopSku.ts
// 「店铺商品ID → 产品」映射的**纯函数层**（只依赖 ./shopName，不碰 better-sqlite3）。
//
// 为什么单独成文件（与 shopName.ts 同理由）：`electron/product-db.ts` 因 better-sqlite3 的
// Electron ABI（149）在系统 Node（127）下无法被 vitest 加载。待关联队列的聚合与匹配是这条链路上
// **唯一有正确性风险**的逻辑，摘成零依赖模块后才能被 `tests/shopSku.spec.ts` 直接覆盖。
//
// 口径（已裁定项，别改宽）
//   1. **商品ID 只做「剥不可见字符 + 去空白」**（复用 `toNameKey`，与店铺名同一口径）：
//      不做大小写折叠、不做模糊匹配。平台商品 ID 是**精确标识**，猜错一次就是把两个产品的账并到一起。
//   2. **一期 spec 恒 `'*'`**：待关联队列按 `(店铺, 商品ID)` 聚合，不按规格拆。
//      `pl_shop_sku.spec` 的列与唯一键保留（D4 已冻结），但只到 P5（变体表）才有非 `'*'` 的生产者。
//      按规格拆会让同一个商品在队列里出现多次 —— 用户要点 N 次，而每一次的答案都一样。
//   3. **`oi_orders` 没有平台字段**：平台只能从店铺实体（`sk_shops.platform`）来，
//      故"店铺未归一"的行**不允许**写入映射（`status='shopUnresolved'`），而不是拿空平台硬塞。
//   4. **人工决定优先**：只有 `sk_name_map` 里 `ref_id > 0` 的店铺算"已归一"；
//      同名唯一精确命中只作为 `autoShopId` 建议（G6：自动命中永不自动落库）。

import { isBetterDisplayRaw, toNameKey } from './shopName';

// ─────────────────────────────────────────────────────────── 归一

/** 商品ID 归一键（与店铺名同一口径：剥不可见字符 → 折叠空白 → trim） */
export function toSkuKey(raw: unknown): string {
  return toNameKey(raw);
}

/** 列表/映射的分隔符：`\u0000` 不会出现在文本里，用它拼复合键不会与真实内容撞车 */
const SEP = '\u0000';

/**
 * 已有映射的查表键：`platform \0 shopId \0 itemId`（一期 spec 恒 '*'，故不进键 —— 见口径 2）。
 *
 * 平台与商品ID **都要归一**：平台的写入口在两处（店铺实体 `sk_shops.platform` 与映射表
 * `pl_shop_sku.platform`），只 trim 不折叠空白的一侧会与另一侧对不上，症状是"明明有关联却查不中"。
 */
export function mappingKey(platform: unknown, shopId: unknown, itemId: unknown): string {
  return `${toNameKey(platform)}${SEP}${Number(shopId) || 0}${SEP}${toSkuKey(itemId)}`;
}

// ─────────────────────────────────────────────────────────── raw_fields 字段提取

/** 商品ID 列名族：与 `src/lib/shipRateOrders.ts` / `orderRowSplitter` 同口径（探测规则只能有一份） */
const ITEM_ID_KEYS = [/商品\s*ID/i, /产品\s*ID/i, /SKU/i, /货号/];
/** 商品标题列名族：**仅用于展示**（让用户在队列里认得出这是哪个商品），不参与匹配 */
const TITLE_KEYS = [/^商品标题$/, /^产品标题$/, /商品标题/, /产品名称/, /商品名称/, /^标题$/, /title/i];

/** 按列名族取值：外层按「具体 → 宽泛」逐条试，命中即返回列名（空值不算命中） */
export function pickField(rawFields: Record<string, string> | null | undefined, patterns: RegExp[]): {
  key: string;
  value: string;
} {
  for (const re of patterns) {
    for (const k of Object.keys(rawFields ?? {})) {
      if (!re.test(k)) continue;
      const v = String(rawFields?.[k] ?? '').trim();
      if (v) return { key: k, value: v };
    }
  }
  return { key: '', value: '' };
}

/** 从一条订单的原始字段里取映射所需信息（商品ID + 展示用标题） */
export function extractSkuFields(rawFields: Record<string, string> | null | undefined): {
  itemId: string;
  title: string;
} {
  return {
    itemId: pickField(rawFields, ITEM_ID_KEYS).value,
    title: pickField(rawFields, TITLE_KEYS).value,
  };
}

// ─────────────────────────────────────────────────────────── 队列聚合

/** 一条订单（数据层从 `oi_orders` 取出的最小投影） */
export interface SkuOrderRow {
  /** 店铺原文（`oi_orders.shop`） */
  shop: string;
  /** `oi_orders.raw_fields`（已 JSON.parse） */
  rawFields: Record<string, string>;
}

/** 聚合后的一组「同一家店 × 同一个商品ID」 */
export interface QueueGroup {
  /** 店铺归一键（`sk_name_map.raw_key` 同口径） */
  shopKey: string;
  /** 展示用店铺原文（同键取最短形态，结果不依赖 SQL 返回顺序） */
  shopRaw: string;
  itemId: string;
  /** 展示用标题（同组取最长的一条 —— 越长的越可能是完整标题；都没有则空串） */
  title: string;
  /** 该组覆盖的订单行数 */
  orderCount: number;
}

export interface AggregateResult {
  groups: QueueGroup[];
  /** 有商品ID的订单行数 */
  withItemId: number;
  /** 没有商品ID的订单行数（列名族没命中，或值为空）—— 必须报出来，否则是"无声丢行" */
  withoutItemId: number;
  /** 是否因为行数上限而提前停止扫描 */
  truncated: boolean;
}

/**
 * 按 `(店铺归一键, 商品ID)` 聚合订单行。
 *
 * @param rows 订单行（调用方分页取全量）
 * @param maxRows 扫描上限（防止在一次同步调用里扫爆大库；超出置 `truncated=true` 由界面提示）
 */
export function aggregateQueue(rows: readonly SkuOrderRow[], maxRows = 50000): AggregateResult {
  const byKey = new Map<string, QueueGroup>();
  let withItemId = 0;
  let withoutItemId = 0;
  let scan = 0;
  const cap = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : 0;

  for (const r of rows) {
    if (cap && scan >= cap) {
      return { groups: sortGroups(byKey), withItemId, withoutItemId, truncated: true };
    }
    scan += 1;
    const shopKey = toNameKey(r?.shop);
    const { itemId, title } = extractSkuFields(r?.rawFields);
    const sku = toSkuKey(itemId);
    if (!sku || !shopKey) {
      // 店铺名为空或商品ID为空：这一行**无法**关联。计数报出（"无商品ID"与"无店铺"分开看
      // 才有排查价值），但不进队列 —— 队列里的每一行都必须是可执行的动作。
      withoutItemId += 1;
      continue;
    }
    withItemId += 1;
    const key = `${shopKey}${SEP}${sku}`;
    const hit = byKey.get(key);
    if (!hit) {
      byKey.set(key, {
        shopKey,
        shopRaw: typeof r?.shop === 'string' ? r.shop : '',
        itemId,
        title,
        orderCount: 1,
      });
      continue;
    }
    hit.orderCount += 1;
    if (isBetterDisplayRaw(typeof r?.shop === 'string' ? r.shop : '', hit.shopRaw)) {
      hit.shopRaw = r.shop;
    }
    if (title.length > hit.title.length) hit.title = title;
  }

  return { groups: sortGroups(byKey), withItemId, withoutItemId, truncated: false };
}

/** 稳定排序：订单行数降序 → 商品ID 升序 → 店铺键升序（不随 Map 插入顺序漂移） */
function sortGroups(map: Map<string, QueueGroup>): QueueGroup[] {
  return [...map.values()].sort(
    (a, b) =>
      b.orderCount - a.orderCount ||
      (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0) ||
      (a.shopKey < b.shopKey ? -1 : a.shopKey > b.shopKey ? 1 : 0),
  );
}

// ─────────────────────────────────────────────────────────── 队列视图（聚合 + 归类）

/** 队列一行：待人工确认的关联项，或"店铺尚未归一"的阻塞项 */
export interface QueueRow {
  shopKey: string;
  shopRaw: string;
  itemId: string;
  title: string;
  orderCount: number;
  /** 已归一的店铺（`sk_name_map.ref_id`）；`shopUnresolved` 时为 0 */
  shopId: number;
  shopName: string;
  platform: string;
  /** 同名**唯一**精确命中给出的建议（永不自动落库，需用户一键采纳 / 指派） */
  autoShopId: number;
  autoShopName: string;
  autoShopPlatform: string;
  /** `shopUnresolved` = 店铺还没归一，**不允许**写映射（见口径 3） */
  status: 'unmapped' | 'shopUnresolved';
}

export interface QueueStats {
  /** 聚合出的组数（未去重前的总量） */
  groups: number;
  /** 已上线返回的行数 */
  shown: number;
  unmapped: number;
  shopUnresolved: number;
  /** 已有生效映射、**不进队列**的组数（说明"关联率"的分母里有它） */
  mapped: number;
  withItemId: number;
  withoutItemId: number;
  truncated: boolean;
}

export interface BuildQueueInput {
  orders: readonly SkuOrderRow[];
  /** 人工归一：店铺归一键 → `sk_shops.id`（来自 `sk_name_map`，`ref_id > 0` 且未忽略） */
  manualShopIdByKey: ReadonlyMap<string, number>;
  /** 同名唯一精确命中的店铺（同名多平台是合法的，此时**不进**本索引 —— 与 shop-db 的 autoMatchIndex 同规则） */
  autoShopByKey: ReadonlyMap<string, { id: number; name: string; platform: string }>;
  /** `sk_shops.id` → 展示信息（把 manualShopId 还原成名字与平台） */
  shopsById: ReadonlyMap<number, { name: string; platform: string }>;
  /** 已有生效映射的键（`mappingKey(...)` 的产物）—— 命中即"已关联"，不进队列 */
  mappedKeys: ReadonlySet<string>;
  /** 单次返回上限 */
  limit?: number;
  maxRows?: number;
}

/**
 * 待关联队列：聚合订单行 → 剔除已关联 → 按店铺是否归一分两类。
 *
 * **实时计算，不做缓存表**（与 `shop-db.listUnmapped` 同理由）：删订单 / 重导 / 改映射之后，
 * 缓存表必然与源头不一致，而"名单里还挂着一个已经不存在的商品"这种错无法自证。
 */
export function buildQueueView(input: BuildQueueInput): { rows: QueueRow[]; stats: QueueStats } {
  const agg = aggregateQueue(input?.orders ?? [], input?.maxRows);
  const manual = input?.manualShopIdByKey ?? new Map<string, number>();
  const auto = input?.autoShopByKey ?? new Map<string, { id: number; name: string; platform: string }>();
  const byId = input?.shopsById ?? new Map<number, { name: string; platform: string }>();
  const mapped = input?.mappedKeys ?? new Set<string>();

  const pending: QueueRow[] = [];
  let mappedCount = 0;

  for (const g of agg.groups) {
    const shopId = manual.get(g.shopKey) ?? 0;
    const shop = shopId ? byId.get(shopId) : undefined;
    const platform = shop?.platform ?? '';
    if (shopId && mapped.has(mappingKey(platform, shopId, g.itemId))) {
      mappedCount += 1;
      continue; // 已关联：不进待办
    }
    const suggestion = auto.get(g.shopKey);
    pending.push({
      shopKey: g.shopKey,
      shopRaw: g.shopRaw,
      itemId: g.itemId,
      title: g.title,
      orderCount: g.orderCount,
      shopId,
      shopName: shop?.name ?? '',
      platform,
      autoShopId: shopId ? 0 : (suggestion?.id ?? 0),
      autoShopName: shopId ? '' : (suggestion?.name ?? ''),
      autoShopPlatform: shopId ? '' : (suggestion?.platform ?? ''),
      status: shopId ? 'unmapped' : 'shopUnresolved',
    });
  }

  const rawLimit = Number(input?.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0;
  const rows = limit ? pending.slice(0, limit) : pending;

  return {
    rows,
    stats: {
      groups: agg.groups.length,
      shown: rows.length,
      unmapped: pending.filter((r) => r.status === 'unmapped').length,
      shopUnresolved: pending.filter((r) => r.status === 'shopUnresolved').length,
      mapped: mappedCount,
      withItemId: agg.withItemId,
      withoutItemId: agg.withoutItemId,
      truncated: agg.truncated,
    },
  };
}
