// electron/mango-sync.ts
// **芒果同步的编排层**：一帧芒果订单 → 认店 → 图落地 → 写订单主干 → 记同步日志。
//
// 为什么是独立文件（而不是塞进 `ae-receiver.ts`）：
//   · `ae-receiver` 是 HTTP 层（token / 限速 / 体积 / 批次上限），它不该知道"图怎么落地"；
//   · 本文件是**编排层**：它允许同时 import 店铺域 / 订单域 / 主数据域（这正是编排层的职责），
//     而 `*-db.ts` 之间的直连要过跨域边守卫。
//
// 三条不变量：
//   1. **写库只有一处**：仍走 `order-db.upsertCollectedOrder`。本层只负责"把草稿补齐"
//      （认店改名、图落地成 imageId），不另写一套 INSERT。
//   2. **图落地失败不阻断入库**：图缺 <= 行缺。图是"能不能看图拣货"的问题，订单是"有没有这一单"
//      的问题 —— 为了图把订单挡在门外，用户看到的是"今天没单"（比"有单没图"坏得多）。
//   3. **每批必须留一条 `sk_sync_log`**：没有日志的自动化等于没有自动化（红线 10）。
//      `fetched=0` 也要写 —— "抓 0 条"和"今天没单"长得一样，只有日志能分开。

import { dbMigrate, dbQuery, dbRun } from './db';
import { ensureMasterDataSchema } from './master-data-db';
import { landOrderImageByUrl } from './order-image-land';
import { ensureOrderSchema, upsertCollectedOrder } from './order-db';
import { bindErpShopIdIfEmpty, ensureShopSchema, shopIdentityIndex } from './shop-db';
import { buildShopMatchIndex, matchShop, toInternal, type ShopMatchIndex } from './mango-ingest';

/**
 * 同步日志表。
 *
 * 为什么必有这张表：`fetched=0` 至少有三种完全不同的原因 —— 今天真的没单 / 登录过期了抓不到 /
 * 扩展根本没装上。三者在一张"0 条"的界面上一模一样，用户唯一的动作是重启再点一次。
 * 有了这张表，采集状态条才能说"上次同步 09:12 · 抓 0 条 · 未登录"。
 *
 * `partial`：翻页中途停下的标记（扩展端检测到服务端无视页码时给的），
 * 它**不是错误**（数据是完整的部分集），但必须让人知道"这次没抓全"。
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sk_sync_log (
  -- 用途：采集同步日志（一行 = 一次同步尝试）；抓 0 条也必须有一条
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL DEFAULT 'mango',
  started_at  TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT '',
  fetched     INTEGER NOT NULL DEFAULT 0,
  -- 芒果自己说的"这个筛选下共几单"。与 fetched 对账才能分出"今天没单"与"抓漏了"
  total_items INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  missing_image INTEGER NOT NULL DEFAULT 0,
  shop_unmatched INTEGER NOT NULL DEFAULT 0,
  partial     INTEGER NOT NULL DEFAULT 0,
  reason      TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`,
  `CREATE INDEX IF NOT EXISTS idx_sk_sync_log_at ON sk_sync_log(kind, id)`,
];

/** 单批最多下多少张图（一次同步的耗时上限；超出的留给下一次，图不是必须立刻齐） */
const MAX_IMAGE_DOWNLOADS = 200;
/** 图片下载并发（与 product-handlers 的采纳并发同量级，别把 CDN 打出 429） */
const IMAGE_CONCURRENCY = 4;

export function ensureMangoSchema(): void {
  dbMigrate(SCHEMA);
}

export interface MangoIngestResult {
  ok: boolean;
  fetched: number;
  /** 芒果说的总数（0 = 没给 / 筛选结果为空） */
  totalItems: number;
  inserted: number;
  updated: number;
  skipped: number;
  /** 图没落地的行数（>0 时界面要提示"这些单没有图"，不是失败） */
  missingImage: number;
  /** 落到未登记桶的订单数（店名认不出 / 没登记） */
  shopUnmatched: number;
  /**
   * 认到了店、但那家店**当前**不是 active 的订单数（已退店 / 封店 / 停用）。
   *
   * 这些单**照常入库、照常归属**（订单归属看下单那一刻，与店铺今天的状态无关），
   * 这个数只是让"退了店却还有单没发"这件事可见 —— 通常意味着芒果那边还有残留单要收尾。
   */
  onClosedShop: number;
  partial: boolean;
  /** 逐条跳过原因（复用 `/ae/ingest` 的形状） */
  skips: { orderNo: string; reason: string }[];
  /** 不影响入库但要记账的提示（缺图 / 币种未折算 / 店名认不出 …） */
  warnings: string[];
  /** 本批实际发生的"学到了新东西"（如把 authId 绑到店铺上） */
  learned: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 简单并发池：按顺序取任务，最多 n 个在飞（不引入依赖） */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

interface MangoPayload {
  schema?: unknown;
  orders?: unknown;
  collectedAt?: unknown;
  /**
   * 扩展端记录的抓取元信息。**统计在 `source` 里，不在顶层**（真机抓包确认）：
   * `{ pageUrl, apiUrl, phase, status, totalItems, fetched, partial, stopReason }`。
   *
   * 为什么必须读它：`totalItems` 是芒果自己说的"这个筛选下共几单"。拿它跟实收帧数对账，
   * 才能区分"今天真没单"与"抓漏了"—— 只看 `orders.length` 时两者都是一样的 0。
   */
  source?: {
    totalItems?: unknown;
    fetched?: unknown;
    partial?: unknown;
    stopReason?: unknown;
    status?: unknown;
    pageUrl?: unknown;
  } | null;
}

/**
 * 一帧芒果订单同步。
 *
 * @param payload 扩展推来的 payload：`{ schema:'mango-order/v1', orders:[...], partial?:boolean }`
 */
export async function ingestMangoOrders(payload: unknown): Promise<MangoIngestResult> {
  const startedAt = nowIso();
  const p = (payload ?? {}) as MangoPayload;
  const rawOrders = Array.isArray(p.orders) ? p.orders : [];
  const src = (p.source ?? {}) as NonNullable<MangoPayload['source']>;
  const totalItems = Math.max(0, Math.round(Number(src.totalItems) || 0));
  const partial = src.partial === true;
  const stopReason = String(src.stopReason ?? '');
  const fetched = Math.max(rawOrders.length, Math.round(Number(src.fetched) || 0));

  const result: MangoIngestResult = {
    ok: true,
    fetched,
    totalItems,
    inserted: 0,
    updated: 0,
    skipped: 0,
    missingImage: 0,
    shopUnmatched: 0,
    onClosedShop: 0,
    partial,
    skips: [],
    warnings: [],
    learned: [],
  };

  // **红线 1：抓 0 条 ≠ 今天没单。**
  // 芒果说"共 12 单"而我们一单没抓到，只可能是登录过期 / 页面没停在待发货筛选 / hook 没生效。
  // 这一条必须进日志的 reason（界面红条），否则用户看到的就是"今天没有订单"然后什么都没发。
  if (!rawOrders.length && totalItems > 0) {
    ensureMangoSchema();
    writeLog({
      startedAt,
      fetched: 0,
      totalItems,
      partial,
      reason: `芒果说共 ${totalItems} 单，但一单都没抓到（登录过期 / 没停在待发货筛选 / 扩展未生效）`,
      detail: { totalItems, status: String(src.status ?? ''), pageUrl: String(src.pageUrl ?? '') },
    });
    result.ok = false;
    return result;
  }

  if (!rawOrders.length) {
    // **抓 0 条也要留痕**：这是"今天没单"与"登录过期"唯一能分开的地方
    ensureMangoSchema();
    writeLog({
      startedAt,
      fetched: 0,
      totalItems,
      partial,
      reason: '这一帧没有任何订单（可能是今天没单，也可能是登录过期/筛选条件不对）',
      detail: { inserted: 0, updated: 0, skipped: 0, status: String(src.status ?? '') },
    });
    return result;
  }

  // 三个域的 schema 都要在：订单主干 / 店铺身份 / 图片仓。缺一个就会在写入时才炸，
  // 而那时已经读了一半数据 —— 懒建表的纪律是"谁读谁保证它在"。
  ensureMangoSchema();
  ensureOrderSchema();
  ensureShopSchema();
  ensureMasterDataSchema();

  const index: ShopMatchIndex = buildShopMatchIndex(shopIdentityIndex());

  // 先把全部订单映射一遍（纯计算，不碰网络）：这样"哪些行要下哪张图"能一次看清，
  // 也不至于在下图中途才发现后半批帧全是坏的。
  const drafts: {
    orderNo: string;
    draft: NonNullable<ReturnType<typeof toInternal>['order']>;
    shopId: number;
    matchedBy: string;
  }[] = [];
  for (const raw of rawOrders) {
    const mapped = toInternal(raw);
    if (!mapped.order) {
      result.skipped += 1;
      if (result.skips.length < 50) {
        const no = String((raw as Record<string, unknown>)?.orderId ?? '').trim();
        result.skips.push({ orderNo: no || `#${result.skips.length + 1}`, reason: mapped.reason });
      }
      continue;
    }
    const match = matchShop(mapped.order.shop, mapped.order.shopAuthId, index);
    if (!match.shopId) result.shopUnmatched += 1;
    // 认到了店、但店已经不在营业：**照样归属这家店**（订单归属是下单那一刻的事实），
    // 只是记一笔让人知道"这家店退了还有单"。绝不因此改走未登记桶。
    if (match.shopId && match.shopStatus && match.shopStatus !== 'active') {
      result.onClosedShop += 1;
    }
    if (match.shop) mapped.order.shop = match.shop; // 命中 ⇒ 写店铺规范名；未命中 ⇒ 保留原文
    for (const w of mapped.warnings) {
      if (result.warnings.length < 50) result.warnings.push(`${mapped.order.orderNo}: ${w}`);
    }
    drafts.push({
      orderNo: mapped.order.orderNo,
      draft: mapped.order,
      shopId: match.shopId,
      matchedBy: match.matchedBy,
    });
  }

  // 图落地：先收集"本批要下的唯一 URL"（同一张图多行只下一次），再并发下载。
  // 上限 `MAX_IMAGE_DOWNLOADS`：超出的行这次没有图（missingImage 计数），下次同步会再补。
  const urls = new Set<string>();
  for (const d of drafts) for (const l of d.draft.lines) if (l.imageUrl) urls.add(l.imageUrl);
  const toFetch = [...urls].slice(0, MAX_IMAGE_DOWNLOADS);
  const skippedByCap = urls.size - toFetch.length;
  const imageIdByUrl = new Map<string, number>();
  await mapLimit<string, null>(toFetch, IMAGE_CONCURRENCY, async (url): Promise<null> => {
    const r = await landOrderImageByUrl(url);
    if (r.ok && r.image) imageIdByUrl.set(url, Number(r.image.imageId));
    return null;
  });
  if (skippedByCap > 0) {
    result.warnings.push(`本批图太多，${skippedByCap} 张这次没下（下次同步会补）`);
  }
  // 抓漏判定：芒果说共 N 单，扩展只送来 M 个且**没标 partial** ⇒ 中间有东西丢了
  // （最常见：翻页到一半页面被切走）。标了 partial 的是"没抓全但知道为什么"，不算异常。
  if (totalItems > 0 && fetched < totalItems && !partial) {
    result.warnings.push(`芒果说共 ${totalItems} 单，只收到 ${fetched} 单（未标 partial，疑似漏抓）`);
  }
  // 已退店/封店的店仍有单：这些单**归属不变**，但值得人说一句 —— 通常是那边还有残留单要收尾。
  // 刻意写成 warning 而不是 reason/bucket：把它当异常会让正常收尾误报，当无事又埋掉真实信号。
  if (result.onClosedShop > 0) {
    result.warnings.push(
      `${result.onClosedShop} 单属于已退店/封店的店铺（归属照旧，只是提示那边还有单没收尾）`,
    );
  }

  // 写库：一单一次（upsertCollectedOrder 内部是整单替换）
  for (const d of drafts) {
    const { draft } = d;
    for (const l of draft.lines) {
      const id = l.imageUrl ? imageIdByUrl.get(l.imageUrl) : 0;
      if (id) l.imageId = id;
      else if (l.imageUrl) result.missingImage += 1;
    }
    const res = upsertCollectedOrder({
      orderNo: draft.orderNo,
      orderTime: draft.orderTime,
      bizStatus: draft.bizStatus,
      shop: draft.shop,
      amountCents: draft.amountCents,
      payTime: draft.payTime,
      shopAuthId: draft.shopAuthId,
      dealDeadline: draft.dealDeadline,
      timeoutAt: draft.timeoutAt,
      rawFields: draft.rawFields,
      lines: draft.lines,
    });
    if (res.refusedReason) {
      result.skipped += 1;
      if (result.skips.length < 50) {
        result.skips.push({ orderNo: draft.orderNo, reason: res.refusedReason });
      }
      continue;
    }
    if (res.replaced) result.updated += 1;
    else result.inserted += 1;
    // 第一次认出店就把 authId 绑上（只补空）：下次直接命中 authId，不再靠名字。
    // 失败（已被别的店占用 / 已绑过）不报错 —— 那是"人已经决定过"的状态。
    if (d.shopId > 0 && d.matchedBy === 'name' && draft.shopAuthId) {
      if (bindErpShopIdIfEmpty(d.shopId, draft.shopAuthId)) {
        result.learned.push(`店铺 ${draft.shop} → 芒果 authId ${draft.shopAuthId}`);
      }
    }
  }

  writeLog({
    startedAt,
    fetched,
    totalItems,
    partial,
    reason: result.skipped ? `${result.skipped} 单未入库（见 skips）` : '',
    detail: {
      totalItems,
      stopReason,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      missingImage: result.missingImage,
      shopUnmatched: result.shopUnmatched,
      onClosedShop: result.onClosedShop,
      ordered: drafts.length,
      imageFetched: imageIdByUrl.size,
      skips: result.skips,
      warnings: result.warnings.slice(0, 20),
      learned: result.learned,
    },
    counters: result,
  });

  return result;
}

function writeLog(input: {
  startedAt: string;
  fetched: number;
  totalItems?: number;
  partial: boolean;
  reason: string;
  detail: unknown;
  counters?: { inserted: number; updated: number; skipped: number; missingImage?: number; shopUnmatched?: number };
}): void {
  const c = input.counters;
  try {
    dbRun(
      `INSERT INTO sk_sync_log
         (kind, started_at, finished_at, fetched, total_items, inserted, updated, skipped,
          missing_image, shop_unmatched, partial, reason, detail_json)
       VALUES ('mango', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.startedAt,
        nowIso(),
        input.fetched,
        Math.max(0, Math.round(Number(input.totalItems) || 0)),
        c?.inserted ?? 0,
        c?.updated ?? 0,
        c?.skipped ?? 0,
        c?.missingImage ?? 0,
        c?.shopUnmatched ?? 0,
        input.partial ? 1 : 0,
        String(input.reason ?? '').slice(0, 500),
        JSON.stringify(input.detail ?? {}).slice(0, 20000),
      ],
    );
  } catch (err: any) {
    // 日志写失败不许让整批同步失败（订单已经进库了，再抛错会让扩展以为要重推）
    console.warn('[mango-sync] 写同步日志失败：', err?.message || err);
  }
}

/** 最近一次同步（采集状态条用；`null` = 从来没同步过） */
export interface MangoSyncStatus {
  at: string;
  fetched: number;
  totalItems: number;
  inserted: number;
  updated: number;
  skipped: number;
  missingImage: number;
  shopUnmatched: number;
  partial: boolean;
  reason: string;
}

export function lastMangoSync(): MangoSyncStatus | null {
  try {
    ensureMangoSchema();
    const r = dbQuery<Record<string, unknown>>(
      `SELECT * FROM sk_sync_log WHERE kind = 'mango' ORDER BY id DESC LIMIT 1`,
    )[0];
    if (!r) return null;
    return {
      at: String(r.finished_at ?? ''),
      fetched: Number(r.fetched) || 0,
      totalItems: Number(r.total_items) || 0,
      inserted: Number(r.inserted) || 0,
      updated: Number(r.updated) || 0,
      skipped: Number(r.skipped) || 0,
      missingImage: Number(r.missing_image) || 0,
      shopUnmatched: Number(r.shop_unmatched) || 0,
      partial: Number(r.partial) === 1,
      reason: String(r.reason ?? ''),
    };
  } catch {
    return null; // 读状态这条路不该抛（采集状态条自己坏了也不能让主界面白屏）
  }
}
