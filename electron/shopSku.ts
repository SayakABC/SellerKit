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
//   5. **平台不参与映射身份**（2026-10-20）：身份 = `(店铺 id, 商品ID)`。`pl_shop_sku.platform`
//      只是写入那一刻的副本（店铺行才是权威），副本一旦参与匹配，改一次平台就废掉该店全部映射。

import { isBetterDisplayRaw, toNameKey } from './shopName';

// ─────────────────────────────────────────────────────────── 归一

/** 商品ID 归一键（与店铺名同一口径：剥不可见字符 → 折叠空白 → trim） */
export function toSkuKey(raw: unknown): string {
  return toNameKey(raw);
}

/** 列表/映射的分隔符：`\u0000` 不会出现在文本里，用它拼复合键不会与真实内容撞车 */
const SEP = '\u0000';

/**
 * 已有映射的查表键：`shopId \0 itemId`（一期 spec 恒 '*'，故不进键 —— 见口径 2）。
 *
 * ⭐ **平台不在键里**（2026-10-20 改）：映射行的 `platform` 是写映射那一刻从店铺行抄来的**副本**，
 * 而店铺实体本身已经隐含唯一平台（`sk_shops` 一行一个 `platform`）。副本参与键的后果是
 * 「店铺登记里把平台改一下（哪怕只是 `AE` → `ae`，`toNameKey` 不折叠大小写）⇒ 该店全部映射一条都不命中」，
 * 用户只能全量重配，重配还会因四列键都不撞而**新增**一行、旧行留成幽灵关联。
 * 映射的真实身份就是 `(店铺, 商品ID)`：店铺 id 全局唯一，跨平台同名店也各有各的 id。
 */
export function bindingKey(shopId: unknown, itemId: unknown): string {
  return `${Number(shopId) || 0}${SEP}${toSkuKey(itemId)}`;
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

/**
 * 展示用标题：**优先标题列，其次「产品信息」的首行**，都没有才回空串。
 *
 * 为什么不能直接用 `extractSkuFields().title`：速卖通（芒果店长）导出的全字段报表里
 * **没有标题列**，标题只出现在「产品信息」那段文本的第一行
 * （`【1】Men's Fashion Thickened Jacket...`）。真库实测：37 个商品里标题列命中 0 个、
 * 而「产品信息」命中 100%（74/75 行），`pl_shop_items.title` 只覆盖 3 个。
 * 命名页要按 listing 分组展示，没有标题就只能显示一串商品ID —— 人认不出那是哪件货。
 *
 * ⚠️ **只用于展示**，不进任何键、不参与匹配（`extractSkuFields` 的行为保持原样：
 *    它喂着"同商品"分组与队列聚合，改它的返回值会改变那些地方的语义）。
 * ⚠️ 多商品拼在一个单元格（`【1】A【2】B`）时取**第一块**：命名页一行只对应一个键，
 *    而那种行在导入时就已经被拆行器拆开了（`orderRowSplitter`），这里只是兜底不为空。
 */
export function productTitleOf(rawFields: Record<string, string> | null | undefined): string {
  const direct = pickField(rawFields, TITLE_KEYS).value;
  if (direct) return direct;
  const info = pickField(rawFields, [/^产品信息$/, /^商品信息$/, /产品信息/, /商品信息/, /产品详情/, /商品详情/]).value;
  if (!info) return '';
  const first = info.split('\n')[0] ?? '';
  return first.replace(/^【\d+】\s*/, '').trim();
}

// ─────────────────────────────────────────────────────────── 按图定色（采集色图 ↔ 订单图）

/**
 * 图片 URL 归一键。
 *
 * 为什么要归一而不是直接比字符串：同一张图在 CDN 上有多种形态 —— 带签名/尺寸查询参数
 * （`?x-oss-process=...`）、缩略图后缀（`...jpg_220x220.jpg`）。订单报表给的是哪一种，
 * 采集详情页给的是哪一种，**不受我们控制** ⇒ 不归一就会出现"明明是同一张图却对不上"，
 * 而这种失败是静默的（回落成"色未定"，看起来跟没采到过一样）。
 *
 * 只剥"确定不属于图本身"的部分（查询串/锚点/尺寸后缀），**不做**小写折叠 ——
 * AE 图床的文件名大小写敏感，折叠会制造假命中。
 */
export function normImageUrl(raw: unknown): string {
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  // `xxx.jpg_220x220.jpg` → `xxx.jpg`（尺寸后缀是 CDN 生成的，不是图的身份）
  return s.replace(/_\d{2,4}x\d{2,4}(\.[a-z0-9]+)?$/i, '');
}

/** 采集 SKU 行里与图片相关的两个字段（`sku_json[]` 的元素） */
export interface SkuColorImageRow {
  color?: string;
  imageUrl?: string;
}

/**
 * 用一张图反查「这个 SKU 图属于哪个颜色」—— 返回**所有**命中的颜色（去重、稳定排序）。
 *
 * 为什么返回数组而不是单个颜色：调用方（`skuColorByItemImage`）要把**多行采集快照**
 * （同商品ID 可能在多家店各有一行）的答案合起来，只在**全局唯一**时才采信。
 * 把"唯一性判定"留在调用方，是为了让"歧义"这件事在一个地方判、而不是每处各判一次。
 *
 * 歧义的真实来源：卖家没给每个颜色单独配图（多色共用一张图）⇒ 一张图对上多个颜色。
 * 这种情况**必须返回多个**、由上游放弃，绝不能取第一个 —— 取第一个就是静默错色。
 */
export function skuColorsByImage(
  rows: readonly SkuColorImageRow[] | null | undefined,
  imageUrl: unknown,
): string[] {
  const target = normImageUrl(imageUrl);
  if (!target) return [];
  const hit = new Set<string>();
  for (const r of rows ?? []) {
    const color = String(r?.color ?? '').trim();
    // `'*'` 是映射里"未指定色"的哨兵，不是采集侧的颜色值
    if (!color || color === '*') continue;
    if (normImageUrl(r?.imageUrl) !== target) continue;
    hit.add(color);
  }
  return [...hit].sort();
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
  /** `oi_order_items.raw_fields`（已 JSON.parse） */
  rawFields: Record<string, string>;
}

/** 聚合后的一组「同一家店 × 同一个商品ID」 */
export interface QueueGroup {
  /** 店铺归一键（`sk_name_map.raw_key` 同口径） */
  shopKey: string;
  /** 展示用店铺原文（同键取最短形态，结果不依赖 SQL 返回顺序） */
  shopRaw: string;
  itemId: string;
  /**
   * **归一后**的商品ID（`toSkuKey`）—— 与 `itemImagePool()` 的池键同口径。
   *
   * 为什么必须单独带一个：`itemId` 是**订单原文**（`extractSkuFields` 直出，可能带空格/不可见字符），
   * 而图池的键是归一的 —— 拿原文去查池**必然落空**且不报错（界面表现为"这批商品一张图都没有"）。
   * 已配映射那半没这个问题，因为 `pl_shop_sku.item_id` 本来就是归一存储的。
   */
  itemKey: string;
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
        itemKey: sku,
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
  /** 归一后的商品ID —— 界面拿它查图（`itemId` 是订单原文，查不到见 `QueueGroup.itemKey`） */
  itemKey: string;
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
  /** 已有生效映射的键（`bindingKey(...)` 的产物）—— 命中即"已关联"，不进队列 */
  mappedKeys: ReadonlySet<string>;
  /**
   * 可选的**末级认店**：店铺原文的归一键落空时，用商品ID 反查采集快照
   * （`shop-item-db.shopIdByItemIds` 的同一份证据；实现方给一张按需加载的表即可）。
   *
   * 为什么放在这里而不是调用方事后修补：队列的「已关联剔除」要用 `shopId` 拼 bindingKey ——
   * 事后修补会让"其实已配映射"的行仍然留在待办里，且统计口径要对两遍。
   * 返回 0 = 认不出（未采到过 / 多店歧义），行为与不传完全一致。
   */
  resolveShopByItemId?: (itemId: string) => number;
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
    // 认店顺序：人工归一 → （落空时）商品ID 反查采集快照。
    // 后者是"这个商品当初归在哪家已登记店"的事实，不是同名相似建议，故与人工归一同样当**已认店**用；
    // 它认不出（0）才落到 `autoShopByKey` 的建议与「店铺未归一」。
    const manualId = manual.get(g.shopKey) ?? 0;
    const byItem = manualId ? 0 : (input?.resolveShopByItemId?.(g.itemId) ?? 0);
    const shopId = manualId || byItem;
    const shop = shopId ? byId.get(shopId) : undefined;
    const platform = shop?.platform ?? '';
    // 只按 (店铺, 商品ID) 判定"已关联"：平台不参与（见 `bindingKey` 注释 —— 副本当键会让改平台废掉全部映射）
    if (shopId && mapped.has(bindingKey(shopId, g.itemId))) {
      mappedCount += 1;
      continue; // 已关联：不进待办
    }
    const suggestion = auto.get(g.shopKey);
    pending.push({
      shopKey: g.shopKey,
      shopRaw: g.shopRaw,
      itemId: g.itemId,
      itemKey: g.itemKey,
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
