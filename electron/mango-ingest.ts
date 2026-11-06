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
// **接口形状有两个来源，都必须认**：
//   ① 芒果原始响应（`SellerKitExtensions/tests/fixtures/mango-search.sample.json`，字段与生产逐字一致）；
//   ② 扩展真正推过来的**规整帧** —— `SellerKitExtensions/extensions/mango-order/src/mango-parse.js`
//      的 `toOrder` 输出（`orderNo` / `shopName` / `lines` / `amountCents` / 已格式化的本地时间串…）。
//
// 为什么必须同时认两套（2026-11-02 线上事故）：扩展推的是 ②，而本层当时只认 ① ⇒ 每一帧都落进
// "缺少 orderId"，4 单全被跳过，响应却是 `ok:true`，扩展只显示"推送 成功（新 0 / 更新 0）"。
// 只改文档猜字段名是不够的：契约测试要拿**扩展自己的解析器**造帧（见 `scripts/mango-ingest-smoke.cjs`）。

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
  // ── 芒果原始响应（路径 ①）
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
  // ── 扩展规整帧（路径 ②，`mango-parse.js` 的 `toOrder`；这是线上真实推送的形状）
  orderNo?: unknown;
  shopName?: unknown;
  shopAuthId?: unknown;
  platformStatusCn?: unknown;
  platformStatus?: unknown;
  status?: unknown;
  /** 扩展已格式化成 `YYYY-MM-DD HH:mm:ss`（本地时区），不是毫秒 */
  orderTime?: unknown;
  payTime?: unknown;
  deadline?: unknown;
  timeoutAt?: unknown;
  currency?: unknown;
  /** 扩展已算成"分"（`toCents`），拿它就别再过一遍 `mangoCents` */
  amountCents?: unknown;
  /** 标签名数组（扩展已把 `labelMap` 摊平） */
  labels?: unknown;
  countryCn?: unknown;
  /** 克（扩展把 `weight` 的千克换成了整数克） */
  weightGram?: unknown;
  /** 扩展的明细数组：`{ itemId, skuCode, qty, color, size, imgUrl, attrs }` */
  lines?: unknown;
  // ── 发货回执（P3a / S1）────────────────────────────────────────────────
  // 原始响应里**一直都有**这三个（`gmtSend` 未发货时是 `null`），扩展规整帧此前**没带**。
  // 两套键名都认：扩展补上字段后宿主零改动（S2），而原始帧今天就能被 `mango-ingest-smoke` 验证。
  /** 原始响应：发货时间（毫秒时间戳；`null` = 还没发） */
  gmtSend?: unknown;
  /** 原始响应：运单号（中文键名族见 `logisticsServiceName`） */
  logisticsNo?: unknown;
  mailNo?: unknown;
  /** 原始响应：承运商名 / 承运商编码（两个都存才有 "中文名对不上编码" 时的人工核对余地） */
  logisticsServiceName?: unknown;
  logisticsTypeCode?: unknown;
  /** 规整帧（S2 起）：扩展已格式化的本地时间串与承运商名 */
  shipTime?: unknown;
  logisticsCarrier?: unknown;
  [key: string]: unknown;
}

const MAX_ORDER_NO = 64;
const MAX_SHOP = 120;
const MAX_STATUS = 64;
const MAX_COLOR = 64;
const MAX_SIZE = 64;
const MAX_ITEM_ID = 64;
const MAX_SKU_CODE = 64;
/** 运单号 / 承运商上限（与状态列同量级；运单号最长实测 20 余位，64 够且不撑爆列） */
const MAX_LOGISTICS = 64;
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

/** 本地时间串（扩展 `toLocalStamp` 的产物）。只认这个形状 —— 别的字符串别往时间列里写 */
const LOCAL_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * 时间取值：先按毫秒/秒解析（原始响应），再回落扩展**已经格式化好的**本地时间串。
 *
 * 为什么要有第二条：扩展 `toOrder` 交的是 `'YYYY-MM-DD HH:mm:ss'`（它已经把毫秒转成本地时间），
 * 而 `mangoTime('2026-11-01 12:00:00')` 得到的是 `''`（`Number()` 是 NaN）——
 * 只走 `mangoTime` 会让规整帧的 `order_time` / `pay_time` 整列变空。
 */
function stampOrText(ms: unknown, text: unknown): string {
  const t = mangoTime(ms);
  if (t) return t;
  const s = str(text);
  return LOCAL_STAMP.test(s) ? s : '';
}

/**
 * 订单一的一把钥匙（两套键名都认）。
 *
 * 抽成函数而不是各处写一遍：`toInternal`（入库）与 `toShipReceipt`（回执同步）必须
 * **认同一个单号**。两边各写一遍的顺序一旦分叉（比如一边先看 `orderNo`），同一帧会出现
 * "入库写成 A、回执记到 B"，而且不会报错 —— 只是有几单永远更新不到。
 */
function pickOrderNo(o: MangoOrderLike): string {
  return clip(str(o.orderId) || str(o.orderNo), MAX_ORDER_NO);
}

/**
 * 状态原文（芒果界面显示的那个）。
 *
 * 取键顺序**只此一份**：`cnOrderStatus`（原始）→ `platformStatusCn`（规整帧）→
 * `orderStatus` / `platformStatus` / `status`（平台英文码兜底）。
 *
 * ⚠️ 这里**不做 bucket 映射**：那是 `src/lib/mangoStatus.ts` 的唯一职责。
 * 换个地方写一套"含已发 ⇒ shipped"就是把「发货台说 3 单待发」和「报单说 5 件要印」
 * 变成两个口径。本层只负责"原样取出来"。
 */
function pickBizStatus(o: MangoOrderLike): string {
  return clip(
    str(o.cnOrderStatus) || str(o.platformStatusCn) || str(o.orderStatus) || str(o.platformStatus) || str(o.status),
    MAX_STATUS,
  );
}

/** 一单的**发货回执**（只含主表那四列需要的值；`''` = 这次没给） */
export interface MangoShipReceipt {
  orderNo: string;
  bizStatus: string;
  shipTime: string;
  logisticsNo: string;
  logisticsCarrier: string;
}

/**
 * 芒果帧里的一单 → 发货回执（**纯映射，不写库**）。
 *
 * 为什么单独一个函数而不是复用 `toInternal`：后者的产物是"入库草稿"（含明细/金额/时效，
 * 少一样就整单拒收）；回执只需要四列，且**必须能在"这一单缺明细"时也完成同步** ——
 * 已发货批里出现残缺帧不该让状态同步失败。
 *
 * 字段来源两套都认（原始响应 / 扩展规整帧），与 `toInternal` 同序：
 *   · `gmtSend`（毫秒，未发货时 `null`）↔ `shipTime`（扩展格式化后的本地串）
 *   · `logisticsNo` / `mailNo`（原始）↔ 扩展 S2 起直接给 `logisticsNo`
 *   · `logisticsServiceName` / `logisticsTypeCode`（原始）↔ `logisticsCarrier`
 *
 * ⚠️ **不从 `raw_fields.采集帧` 里挖历史发货时间**：待发货时抓的帧里 `gmtSend` 本来就是
 *   `null`，挖一遍只能捞到"采集那一刻已经发出去"的零星单 —— 补出来的样本有偏，
 *   比"没有"更容易误导。
 */
export function toShipReceipt(frame: unknown): { receipt: MangoShipReceipt | null; reason: string } {
  if (!frame || typeof frame !== 'object') return { receipt: null, reason: '订单不是对象' };
  const o = frame as MangoOrderLike;
  const orderNo = pickOrderNo(o);
  if (!orderNo) return { receipt: null, reason: '缺少订单号（orderId / orderNo）' };
  return {
    receipt: {
      orderNo,
      bizStatus: pickBizStatus(o),
      shipTime: stampOrText(o.gmtSend, o.shipTime),
      logisticsNo: clip(str(o.logisticsNo) || str(o.mailNo), MAX_LOGISTICS),
      logisticsCarrier: clip(
        str(o.logisticsServiceName) || str(o.logisticsCarrier) || str(o.logisticsTypeCode),
        MAX_LOGISTICS,
      ),
    },
    reason: '',
  };
}

/** 一批帧 → 回执入参（`bad` 是跳过原因，绝不静默丢单） */
export interface MangoShipReceiptPlan {
  receipts: MangoShipReceipt[];
  bad: { orderNo: string; reason: string }[];
  /**
   * 这批里**带发货时间**的单数。
   *
   * 这是判断"这一帧是不是回执批"的**机械事实**，不是猜筛选参数（`source.status` 是芒果
   * 自己的编码，语义随版本变）。用途只有一个：日志里写"12 单里 12 单带发货时间"，
   * 让人一眼看出"这次抓的是已发货列表"还是"待发货列表被误当回执处理了"。
   */
  withShipTime: number;
}

/**
 * 批量映射（纯计算，不碰网络/库）。
 *
 * `bad` 保留前 50 条（与 `ingestMangoOrders` 的 skips 同口径）：一次坏 500 单时
 * 界面只显示 500 个原因没人读，显示 50 个 + 总数才有用。
 */
export function planShipReceipt(orders: unknown): MangoShipReceiptPlan {
  const list = Array.isArray(orders) ? orders : [];
  const plan: MangoShipReceiptPlan = { receipts: [], bad: [], withShipTime: 0 };
  for (const raw of list) {
    const r = toShipReceipt(raw);
    if (!r.receipt) {
      if (plan.bad.length < 50) {
        // 用 `pickOrderNo` 而不是只认 `orderId`：规整帧只有 `orderNo`，
        // 只认一套会让"跳过原因"里的单号显示成 `#1`（人照着编号去芒果搜不到这单）。
        const no = pickOrderNo(raw as MangoOrderLike);
        plan.bad.push({ orderNo: no || `#${plan.receipts.length + plan.bad.length + 1}`, reason: r.reason });
      }
      continue;
    }
    if (r.receipt.shipTime) plan.withShipTime += 1;
    plan.receipts.push(r.receipt);
  }
  return plan;
}

/**
 * 一批帧 → 回执批 / 待发批（**分流判据的唯一实现**）。
 *
 * 判据只有一条：**帧内这一单带没带发货时间**（`gmtSend` 原始值 / `shipTime` 规整值）。
 *
 * 为什么不用 `source.status`：那是芒果自己的筛选编码（`sp.get('status')`），语义随版本变；
 * 拿它分流等于把"平台改了个枚举"变成"已发货单被当成待发货单做整单替换"，
 * 而整单替换会**静默**清掉归类与图案绑定（`upsertCollectedOrder` 是 DELETE + 重插）。
 *
 * 缺单号的帧落回 `pending`，交给 `toInternal` 用它那套更具体的原因拒收
 * （"缺少订单号（orderId / orderNo）"），不在这里造一个次等理由。
 */
export function splitShipBatch(orders: unknown): {
  receipts: MangoShipReceipt[];
  pending: unknown[];
} {
  const list = Array.isArray(orders) ? orders : [];
  const receipts: MangoShipReceipt[] = [];
  const pending: unknown[] = [];
  for (const raw of list) {
    const rc = toShipReceipt(raw);
    if (rc.receipt && rc.receipt.shipTime) receipts.push(rc.receipt);
    else pending.push(raw);
  }
  return { receipts, pending };
}

/**
 * 一帧芒果订单 → 内部草稿。
 *
 * 三条判定：
 *   1. **没有单号就整帧拒绝**（`order=null` + 原因）—— 空单号会在主表撞
 *      `NOT NULL UNIQUE`，且"不知道是哪一单"本来也无从合并；
 *      单号两个键名（原始响应 `orderId` / 扩展规整帧 `orderNo`）都认；
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
  // 两套键名：原始响应 `orderId` / 扩展规整帧 `orderNo`。哪个有值用哪个（不许只认一套）。
  const orderNo = pickOrderNo(o);
  if (!orderNo) return { order: null, reason: '缺少订单号（orderId / orderNo）', warnings };

  const shopAuthId = clip(str(o.authId) || str(o.shopAuthId), MAX_ORDER_NO);
  const shop = clip(str(o.alias) || str(o.shopName), MAX_SHOP);
  if (!shop) warnings.push(`店铺别名为空（authId=${shopAuthId || '无'}），落未登记桶`);

  const bizStatus = pickBizStatus(o);
  if (!bizStatus) warnings.push('订单状态为空（发货台无法判断待发/已发）');

  // 金额：`payAmount` 是订单实付。币种不是 CNY 时**不折算、给 null** ——
  // 汇率属 ae 域（`ae_rates`），本层零依赖读不到，猜一个 1:1 就是把外币单记成人民币。
  // 扩展已在那边算好"分"（`amountCents`），此时**不要再乘 100**。
  const currency = (str(o.currencyCode) || str(o.currency) || 'CNY').toUpperCase();
  const prefilledCents =
    typeof o.amountCents === 'number' && Number.isFinite(o.amountCents) ? Math.round(o.amountCents) : null;
  const amountCents = currency === 'CNY' ? (prefilledCents ?? mangoCents(o.payAmount)) : null;
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
  const dealDeadline = stampOrText(o.sendGoodExpiredDate, o.deadline);
  const timeoutAt = stampOrText(internet?.qualifiedTime, o.timeoutAt);
  if (!dealDeadline) warnings.push('缺少最晚发货日（无法算截止风险）');

  const items = Array.isArray(o.orderItemList)
    ? o.orderItemList
    : Array.isArray(o.lines)
      ? o.lines
      : [];
  const lines: MangoOrderDraft['lines'] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const it = (raw ?? {}) as Record<string, unknown>;
    // 商品ID：原始响应 `productId` / 扩展规整帧 `itemId`
    const itemId = clip(str(it.productId) || str(it.itemId), MAX_ITEM_ID);
    // `attrMap` 是**结构化**的（真机抓包确认），不需要解析规格文本 —— 当初"规格不可靠"
    // 的担心在接口这条路上不存在。键名按实测：`Color` / `Size`（大小写敏感）。
    // 扩展规整帧把色/码提到了行上（`color` / `size`），两者都认。
    const attrs = (it.attrMap ?? it.attrs ?? {}) as Record<string, unknown>;
    const color = clip(str(attrs['Color']) || str(attrs['color']) || str(it.color), MAX_COLOR);
    const size = clip(str(attrs['Size']) || str(attrs['size']) || str(it.size), MAX_SIZE);
    const skuCode = clip(str(it.skuCode), MAX_SKU_CODE);
    const imageUrl = str(it.productImgUrl) || str(it.productBigImgUrl) || str(it.imgUrl);
    const qtyRaw = it.productCount === undefined ? it.qty : it.productCount;
    const qty = Math.max(1, Math.round(Number(qtyRaw) || 1));
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
  // 原始响应是 `countryCode`+`labelMap`+`weight(kg)`；扩展规整帧是 `countryCn`+`labels[]`+`weightGram`。
  const country = str(o.countryCode) || str(o.countryCn);
  if (country) rawFields['目的地国家'] = country;
  const labels = mangoLabels(o.labelMap);
  if (labels.length) {
    rawFields['订单标签'] = labels.join('、');
  } else if (Array.isArray(o.labels)) {
    const names = o.labels.map((x) => str(x)).filter(Boolean);
    if (names.length) rawFields['订单标签'] = names.join('、');
  }
  const weightKg = Number(o.weight);
  const grams = Number(o.weightGram);
  if (Number.isFinite(weightKg) && weightKg > 0) rawFields['重量kg'] = String(weightKg);
  else if (Number.isFinite(grams) && grams > 0) rawFields['重量kg'] = (grams / 1000).toFixed(3);

  return {
    order: {
      orderNo,
      orderTime: stampOrText(o.aeGmtCreate, o.orderTime) || stampOrText(o.gmtPayTime, o.payTime),
      bizStatus,
      shop,
      amountCents,
      payTime: stampOrText(o.gmtPayTime, o.payTime),
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
