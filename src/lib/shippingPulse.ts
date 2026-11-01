// src/lib/shippingPulse.ts
// 「发货台 › 总览」第二行四数（2026-11-01，T2-2）：待发货 / 有截止风险 / 件数 / 缺图。
//
// 为什么与 `dailyShip` 分开、而不是加进它的四个数里：
// **批次范围不同**。`dailyShip` 回答"今天导进来的这批要发几单"（按导入日筛，服务导入/归类两步）；
// 本文件回答"现在手上还有几单没发"（跨天 —— 昨天没发完的单今天还在）。两者重叠度很高但不是同一批，
// 混成一行会出现"待发货 0 但今天要发 12 单"这种自相矛盾的画面。
//
// 三个刻意的口径：
//   ① **待发货只认 `mangoStatus.isWaitingShip`**（唯一实现）。别在这里写 `=== '待发货'`：
//      芒果不同页面给「等待卖家发货」/「待发货」/「待卖家发货」，全等匹配等于静默漏单。
//   ② **没有截止期 ≠ 不会超时**。导入单根本没有 `deal_deadline`，把它当"不超时"会让
//      「有截止风险」看起来永远很小。所以空截止期单独计 `noDeadline`，界面要说
//      "其中 N 单没有截止期" —— 让"算不出来"和"不会超时"分开。
//   ③ **己超时的也算风险**（`t <= now`）。截止期过了还没发是最该看见的一档，
//      把它排除掉等于"越紧急越不提醒"。
//
// 时间解析**手写而不用 `new Date(s)`**：`yyyy-mm-dd hh:mm:ss` 这种带空格的格式在
// `Date` 构造器里的行为是**实现相关**的（V8 当本地时间、有的引擎当 Invalid Date），
// 而这一屏显示的是"还剩几小时"，解析错一小时就是错的告警。

import { isWaitingShip } from './mangoStatus';

/** 一行输入（`order-shipping-rows` 投影里本层要用的那几列） */
export interface PulseRow {
  orderNo: string;
  /** 平台状态原文（`oi_orders.biz_status`） */
  bizStatus: string;
  /** 最晚发货时点 `yyyy-mm-dd hh:mm:ss`（芒果 `sendGoodExpiredDate`，D-2 已定）；空串 = 不知道 */
  dealDeadline: string;
  /** 行图 id；0 = 没落地 */
  imageId: number;
  /** 件数真值；null = 不知道（导入侧由渲染层解析，这里按 1 兜底并计数） */
  qty?: number | null;
}

export interface ShippingPulse {
  /** 待发货**单数**（按单号去重 —— 一单三行还是"1 单要发"） */
  pending: number;
  /** 待发货里**有截止风险**的单数（24h 内到截止，或已过期） */
  risk: number;
  /** 待发货**件数**（`qty` 为空按 1 计，并计入 `assumedQty`） */
  pieces: number;
  /** 待发货里**没有行图**的行数（`image_id = 0`）—— 「缺图 K」 */
  missingImage: number;
  /** 待发货里**算不出截止风险**的单数（没有截止期，或写了但格式认不出）—— >0 时"风险"是偏小的，界面要说 */
  noDeadline: number;
  /** 件数按 1 兜底的行数（>0 时件数偏小，界面要说） */
  assumedQty: number;
}

/** 「快超时」的窗口：24 小时（含已过期） */
export const RISK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * `yyyy-mm-dd hh:mm[:ss]` → 本地时区毫秒时间戳。认不出返回 **0**。
 *
 * 只认这一种形状（以及 `T` 分隔、`/` 与 `.` 作日期分隔 —— 库里有历史行的写法）：
 * 别去兼容"相对时间"或 RFC 字符串，那会把解析失败伪装成解析成功。
 */
export function parseLocalTime(raw: unknown): number {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 0;
  const m = /^(\d{4})[-/.](\d{2})[-/.](\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return 0;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  const ss = Number(m[6] ?? 0);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return 0;
  const t = new Date(y, mo - 1, d, hh, mi, ss, 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * 算第二行四数。
 *
 * @param rows 订单行（**全库**投影，不是"今天导入的"——见文件头）
 * @param opts.now 当前时间（毫秒）；缺省取系统时间。**测的时候必须传**，否则断言会随运行时刻漂
 */
export function shippingPulse(
  rows: PulseRow[] | null | undefined,
  opts: { now?: number } = {},
): ShippingPulse {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const out: ShippingPulse = {
    pending: 0,
    risk: 0,
    pieces: 0,
    missingImage: 0,
    noDeadline: 0,
    assumedQty: 0,
  };
  const list = Array.isArray(rows) ? rows : [];

  // 单级判定要"一单只算一次"：状态与截止期是**订单级**的（`oi_orders` 上的列），
  // 一单多行时逐行累加会把"1 单待发"数成 3 单。件数与缺图才是行级的。
  const pendingOrders = new Map<string, { deadline: number; raw: string }>();
  const seenOrder = new Set<string>();

  for (const r of list) {
    if (!isWaitingShip(r?.bizStatus)) continue;
    const no = String(r?.orderNo ?? '');
    if (no && !seenOrder.has(no)) {
      seenOrder.add(no);
      pendingOrders.set(no, { deadline: parseLocalTime(r?.dealDeadline), raw: String(r?.dealDeadline ?? '') });
    }
    // 件数（行级）
    const q = r?.qty;
    const n = typeof q === 'number' && Number.isFinite(q) && q > 0 ? Math.round(q) : 0;
    if (n) out.pieces += n;
    else {
      out.pieces += 1;
      out.assumedQty += 1;
    }
    // 缺图（行级）：0 或空都算没图
    if (!(Number(r?.imageId) > 0)) out.missingImage += 1;
  }

  out.pending = pendingOrders.size;
  for (const [, v] of pendingOrders) {
    if (!v.deadline) {
      // 没有截止期（或格式认不出）**不是** 不会超时：单独计数，让界面能说"这 N 单算不出风险"。
      // 认不出的也归进来（而不是静默跳过）：一个写坏的日期如果什么都不体现，
      // 就是"风险数永远是 0"而没人知道为什么。
      out.noDeadline += 1;
      continue;
    }
    if (v.deadline - now <= RISK_WINDOW_MS) out.risk += 1;
  }
  return out;
}
