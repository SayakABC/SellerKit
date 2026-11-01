// electron/mango-ingest.ts
// **芒果店长订单帧 → 内部结构**的纯函数层（零依赖：不碰 better-sqlite3 / fs / electron）。
//
// 为什么单独成文件（与 `variantKey.ts` / `shopSku.ts` 同一理由）：`*-db.ts` 因 better-sqlite3 的
// Electron ABI 在系统 Node 下 load 不进来，只能走 `scripts/*-db-smoke.cjs`。而"芒果的一个订单
// 对象怎么变成我库里的一单"是这条链路上**最容易悄悄错**的一段（字段名靠猜、时间戳是毫秒、
// 金额币种不明、状态是中文原文），摘成零依赖模块后才能被 vitest 直接覆盖。
//
// 本层**只做映射与校验，不写库**：写库仍走 `order-db.upsertCollectedOrder`（一处写口径不分裂）。
// 所以这里定义的是**结构同构**的草稿类型，而不是 import 那个模块的类型 —— 一旦 import，
// 本文件就被 better-sqlite3 拖下水，vitest 再也测不了。
//
// 接口形状的唯一来源是真实响应：`SellerKitExtensions/tests/fixtures/mango-search.sample.json`
// （脱敏后的抓包，字段与生产逐字一致）。改这里之前先看它，别照文档猜字段名。

// 注意本文件唯一的 import：`shopName` 是纯函数模块（零 better-sqlite3 依赖），
// 店名归一口径只有它一份 —— 谁自己 trim，谁就会把"十店"和"十店 "拆成两家。
import { toNameKey } from './shopName';

/** 一单的草稿（结构上可直接喂 `upsertCollectedOrder`） */
export interface MangoOrderDraft {
  orderNo: string;
  orderTime: string;
  bizStatus: string;
  shop: string;
  amountCents: number | null;
  payTime: string;
  shopAuthId: string;
  dealDeadline: string;
  timeoutAt: string;
  rawFields: Record<string, string>;
  lines: {
    itemId: string;
    qty: number;
    color: string;
    size: string;
    skuCode: string;
    imageUrl: string;
    /**
     * 图片落地后的 `md_images.id`（**编排层补的**，本层不产出 —— 这里还不存在图）。
     * 缺省 = 还没落地 / 落地失败（写库时是 NULL，不是 0）。
     */
    imageId?: number;
  }[];
}

export interface MangoToInternalResult {
  /** `null` ⇒ 这一帧不可入库，`reason` 说明为什么（**不抛错**：一帧坏不该让整批失败） */
  order: MangoOrderDraft | null;
  reason: string;
  /**
   * 能入库但"信息不完整"的提示（缺店名 / 缺图 / 金额币种非 CNY …）。
   *
   * 为什么要单独一列而不是塞进 reason：这些不影响入库，但每一条都对应一个"以后会来问
   * 为什么这个字段是空的"的场景。写进同步日志，比事后猜有用。
   */
  warnings: string[];
}

/** 芒果帧里可能会读到的字段（宽松：真实响应里字段远不止这些，未知字段一律原样保留进快照） */
interface MangoOrderLike {
  orderId?: unknown;
  alias?: unknown;
  authId?: unknown;
  aeGmtCreate?: unknown;
  gmtPayTime?: unknown;
  sendGoodExpiredDate?: unknown;
  payAmount?: unknown;
  currencyCode?: unknown;
  cnOrderStatus?: unknown;
  orderStatus?: unknown;
  countryCode?: unknown;
  weight?: unknown;
  labelMap?: unknown;
  orderItemList?: unknown;
  aeInternetInfoDTO?: unknown;
  [key: string]: unknown;
}

const MAX_ORDER_NO = 64;
const MAX_SHOP = 120;
const MAX_STATUS = 64;
const MAX_COLOR = 64;
const MAX_SIZE = 64;
const MAX_ITEM_ID = 64;
const MAX_SKU_CODE = 64;
/** `raw_fields` 单值上限（整帧快照也走这个；一条脏数据不该把列撑爆） */
const MAX_RAW_VALUE = 20000;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

function clip(s: string, max: number): string {
  return s.slice(0, max);
}

/**
 * 芒果时间戳 → `YYYY-MM-DD HH:mm:ss`（**本地时区**）。认不出返回 `''`。
 *
 * 为什么必须本地时区：库里的 `order_time` 全线按本地时间理解（报表导入的是北京时间），
 * 若这里按 UTC 格式化，同一单在"按下单日聚合"的页面上会**跨天**跑到前一天去。
 *
 * 毫秒/秒的判定：芒果给 13 位毫秒（实测 `1793450497000`）。10 位秒级也见过，
 * 两者相差三个数量级、**可以确定地分辨**（不是猜）：
 *   · ≥ 1e12            → 毫秒
 *   · 1e9 ≤ v < 1e12    → 秒
 *   · 其余（0/负数/NaN）→ `''`，绝不产出 1970
 */
export function mangoTime(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n >= 1e12 ? n : n >= 1e9 ? n * 1000 : 0;
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 元 → 分（`null` = 算不出，**不是 0**：0 会让"缺金额"伪装成"免费单"） */
export function mangoCents(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** 标签：`labelMap.{normal,risk,…}[].name` → 名字数组（去重、稳定排序，空则空数组） */
export function mangoLabels(v: unknown): string[] {
  const out = new Set<string>();
  if (v && typeof v === 'object') {
    for (const arr of Object.values(v as Record<string, unknown>)) {
      if (!Array.isArray(arr)) continue;
      for (const it of arr) {
        const name = str((it as Record<string, unknown> | null)?.name);
        if (name) out.add(name);
      }
    }
  }
  return [...out].sort();
}

/**
 * 一帧芒果订单 → 内部草稿。
 *
 * 三条判定：
 *   1. **没有 orderId 就整帧拒绝**（`order=null` + 原因）—— 空单号会在主表撞
 *      `NOT NULL UNIQUE`，且"不知道是哪一单"本来也无从合并；
 *   2. **没有店名不拒绝**：`shop=''` 落"未登记桶"（与 `matchShopByStore` 同口径 —— 店名
 *      认不出是数据问题，不该让订单进不来；`shop_auth_id` 还在，后续能补）；
 *   3. **空明细也不拒绝**：插一行占位（件数 1），因为"订单数"不能被帧的空误吞掉。
 *      这一行没有商品ID ⇒ 变体键为空 ⇒ 落到待归类，是诚实的状态。
 */
export function toInternal(frame: unknown): MangoToInternalResult {
  const warnings: string[] = [];
  if (!frame || typeof frame !== 'object') {
    return { order: null, reason: '订单不是对象', warnings };
  }
  const o = frame as MangoOrderLike;
  const orderNo = clip(str(o.orderId), MAX_ORDER_NO);
  if (!orderNo) return { order: null, reason: '缺少 orderId', warnings };

  const shopAuthId = clip(str(o.authId), MAX_ORDER_NO);
  const shop = clip(str(o.alias), MAX_SHOP);
  if (!shop) warnings.push(`店铺别名为空（authId=${shopAuthId || '无'}），落未登记桶`);

  // 状态取中文原文（芒果界面显示的那个）。`cnOrderStatus` 缺失时回落 `orderStatus`（平台英文码）
  // —— 两者都存原文，**不在这里做 bucket 映射**（那是 `src/lib/mangoStatus.ts` 的唯一职责，
  // 一处实现；这里换一套就是把「发货台说 3 单待发」和「报单说 5 件要印」变成两个口径）。
  const bizStatus = clip(str(o.cnOrderStatus) || str(o.orderStatus), MAX_STATUS);
  if (!bizStatus) warnings.push('订单状态为空（发货台无法判断待发/已发）');

  // 金额：`payAmount` 是订单实付。币种不是 CNY 时**不折算、给 null** ——
  // 汇率属 ae 域（`ae_rates`），本层零依赖读不到，猜一个 1:1 就是把外币单记成人民币。
  const currency = (str(o.currencyCode) || 'CNY').toUpperCase();
  const amountCents = currency === 'CNY' ? mangoCents(o.payAmount) : null;
  if (currency !== 'CNY') {
    warnings.push(`币种 ${currency} 未折算（缺汇率链），金额记 null 而不是猜一个数`);
  } else if (amountCents === null) {
    warnings.push('payAmount 缺失或非法，金额记 null');
  }

  // 两个时效时点都存（实测差 6 天：`sendGoodExpiredDate` 11-11 / `qualifiedTime` 11-05）。
  // **D-2 已定（2026-11-01 用户确认）**：`sendGoodExpiredDate` 就是真倒计时 ⇒ 落 `deal_deadline`，
  // 「有截止风险」只认这一列。`qualifiedTime` 仍存进 `timeout_at` 但**不参与任何判定** ——
  // 两者差的是稳定的 6 天，"取更近的那个"会把固定偏差纠成一堆假告警，假告警三天就没人看了。
  const internet = (o.aeInternetInfoDTO ?? null) as Record<string, unknown> | null;
  const dealDeadline = mangoTime(o.sendGoodExpiredDate);
  const timeoutAt = mangoTime(internet?.qualifiedTime);
  if (!dealDeadline) warnings.push('缺少最晚发货日（无法算截止风险）');

  const items = Array.isArray(o.orderItemList) ? o.orderItemList : [];
  const lines: MangoOrderDraft['lines'] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const it = (raw ?? {}) as Record<string, unknown>;
    const itemId = clip(str(it.productId), MAX_ITEM_ID);
    const attrs = (it.attrMap ?? {}) as Record<string, unknown>;
    // `attrMap` 是**结构化**的（真机抓包确认），不需要解析规格文本 —— 当初"规格不可靠"
    // 的担心在接口这条路上不存在。键名按实测：`Color` / `Size`（大小写敏感）。
    const color = clip(str(attrs['Color']) || str(attrs['color']), MAX_COLOR);
    const size = clip(str(attrs['Size']) || str(attrs['size']), MAX_SIZE);
    const skuCode = clip(str(it.skuCode), MAX_SKU_CODE);
    const imageUrl = str(it.productImgUrl) || str(it.productBigImgUrl);
    const qty = Math.max(1, Math.round(Number(it.productCount) || 1));
    // 同帧内**同一个 skuCode 只留一行**（芒果偶有重复行：合并订单展开）。没有 skuCode 时
    // 用"商品ID+色+码"作去重键 —— 宁可少一条重复行，不要同一件货算两遍。
    const identified = Boolean(itemId || color || size);
    const dedupeKey = skuCode || `${itemId}\u0000${color}\u0000${size}`;
    if (identified && seen.has(dedupeKey)) {
      warnings.push(`帧内重复行被合并（${dedupeKey.split('\u0000').join('/')}）`);
      continue;
    }
    seen.add(dedupeKey);
    if (!itemId) warnings.push('明细缺商品ID（这一行无法绑图案）');
    if (!imageUrl) warnings.push(`明细缺 SKU 图（商品 ${itemId || '?'}）`);
    lines.push({ itemId, qty, color, size, skuCode, imageUrl });
  }
  if (!lines.length) warnings.push('明细为空（插一行占位，保订单数）');

  // 保真快照：整帧原文进 `采集帧`（截断到 20000 字符，防一条脏数据撑爆列）。
  // ⚠️ 行级可识别字段（`商品ID` / `产品属性`）**不在这里加** —— `upsertCollectedOrder`
  // 会按行补（那里才知道这一行的商品ID，一单多商品时加在这里会让整单的键塌成第一行的值）。
  const rawFields: Record<string, string> = {
    采集帧: JSON.stringify(o).slice(0, MAX_RAW_VALUE),
  };
  // 几个"人要看"的字段另存一份，免得翻 JSON 才能回答"这单发到哪、多重"。
  const country = str(o.countryCode);
  if (country) rawFields['目的地国家'] = country;
  const labels = mangoLabels(o.labelMap);
  if (labels.length) rawFields['订单标签'] = labels.join('、');
  const weight = Number(o.weight);
  if (Number.isFinite(weight) && weight > 0) rawFields['重量kg'] = String(weight);

  return {
    order: {
      orderNo,
      orderTime: mangoTime(o.aeGmtCreate) || mangoTime(o.gmtPayTime),
      bizStatus,
      shop,
      amountCents,
      payTime: mangoTime(o.gmtPayTime),
      shopAuthId,
      dealDeadline,
      timeoutAt,
      rawFields,
      lines,
    },
    reason: '',
    warnings,
  };
}

// ─────────────────────────────────────────────────────────── 店铺匹配
//
// 芒果订单帧里**没有速卖通店铺 ID**，只有两个东西能用来认店：
//   · `authId`（ERP 内部店铺 id，稳定、精确，但不是每家店都登记过）；
//   · `alias`（用户自己在芒果里起的名字，人可读，但会改、可能重名）。
// 匹配顺序必须是 `authId` 优先：名字改了（"十店" → "十号店"）不该让订单掉进未登记桶，
// 而 authId 是 ERP 内部分配的，改不了。名字只作**首次**的回退 —— 一旦匹配上，
// 调用方会把 authId 补写到店铺行（`bindErpShopIdIfEmpty`），下次就直接命中第一条。

/** 匹配索引（由 `shop-db.shopIdentityIndex()` 喂进来；本层不读库，故用纯结构） */
export interface ShopMatchIndex {
  byErpShopId: Map<string, { id: number; name: string; status: string }>;
  byNameKey: Map<string, { id: number; name: string; status: string }>;
  /** 同名多家店的 nameKey —— **不参与匹配**（见 `buildShopMatchIndex`） */
  nameAmbiguous: Set<string>;
}

export interface ShopMatch {
  /** 命中店铺主键；0 = 未登记桶（订单照样入库） */
  shopId: number;
  /** **要写进订单的店名**：命中 ⇒ 店铺规范名；未命中 ⇒ 芒果原文 */
  shop: string;
  /** 命中路径（排障用）：'erp' / 'name' / '' */
  matchedBy: 'erp' | 'name' | '';
  /**
   * 命中店铺**当前**状态（未命中为 ''）。
   *
   * 只用于事后可见性（"这家店退了却还有单待发"），**绝不参与匹配判定** ——
   * 退店只说明这家店现在不开，不改变它退店前那些单归谁。
   */
  shopStatus: string;
}

/** 用店铺清单构建匹配索引 */
export function buildShopMatchIndex(
  rows: readonly { id: number; name: string; nameKey?: string; erpShopId?: string; status?: string }[],
): ShopMatchIndex {
  const byErpShopId = new Map<string, { id: number; name: string; status: string }>();
  const byNameKey = new Map<string, { id: number; name: string; status: string }>();
  const nameAmbiguous = new Set<string>();
  const counted = new Map<string, number>();
  for (const r of rows) {
    const id = Number(r.id) || 0;
    const name = String(r.name ?? '');
    const nameKey = String(r.nameKey ?? '') || toNameKey(name);
    const erp = String(r.erpShopId ?? '').trim();
    const status = String(r.status ?? '');
    if (id <= 0) continue;
    if (erp && !byErpShopId.has(erp)) byErpShopId.set(erp, { id, name, status });
    if (nameKey) {
      counted.set(nameKey, (counted.get(nameKey) ?? 0) + 1);
      if (!byNameKey.has(nameKey)) byNameKey.set(nameKey, { id, name, status });
    }
  }
  // 同名多家店（跨平台同名是真实场景）：**按名匹配一律放弃**。
  // 取第一个就是把订单落给一个"恰好叫这个名字"的店 —— 图案、成本、发货时效全跟着错，
  // 且事后无从发现（订单上写着的是一个完全合法的店名）。
  for (const [key, n] of counted) if (n > 1) nameAmbiguous.add(key);
  return { byErpShopId, byNameKey, nameAmbiguous };
}

/**
 * 认店：`authId` → 店名 → 未登记桶。
 *
 * 未命中时返回 `shopId=0` 且 **`shop` 保留芒果原文**：订单仍要进来（"认不出店"是数据问题，
 * 不是丢单的理由），而原文留着才能让人在「店铺归一」页看到"这家店还没登记"。
 *
 * **店状态不参与判定**：退店/封店的店与活跃店一视同仁 —— 订单归属看下单那一刻，
 * 店今天开不开是另一回事。状态只随 `shopStatus` 带出去供调用方统计。
 */
export function matchShop(shopRaw: string, authId: string, index: ShopMatchIndex): ShopMatch {
  const erp = String(authId ?? '').trim();
  if (erp) {
    const hit = index.byErpShopId.get(erp);
    if (hit) return { shopId: hit.id, shop: hit.name, matchedBy: 'erp', shopStatus: hit.status };
  }
  const key = toNameKey(shopRaw);
  if (key && !index.nameAmbiguous.has(key)) {
    const hit = index.byNameKey.get(key);
    if (hit) return { shopId: hit.id, shop: hit.name, matchedBy: 'name', shopStatus: hit.status };
  }
  return { shopId: 0, shop: String(shopRaw ?? '').trim(), matchedBy: '', shopStatus: '' };
}
