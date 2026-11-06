// src/lib/shippingPulse.ts
// 「发货台 › 总览」第二行四数（2026-11-01，T2-2）+ 「待发货清单」（2026-11-01，T2-4）。
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
//
// ⚠️ **清单与四数是同一份实现**（T2-4）：`shippingQueue()` 出行，`shippingPulse()` 只是它的汇总。
//    分别写两遍的必然结果是一边按单去重、一边按行累加 —— 界面上一句"待发货 3 单"、
//    下面清单列 5 行，用户没法判断哪个是真的（而他第一步要判断的恰恰是"今天还有几单要发"）。

import { isWaitingShip } from './mangoStatus';

/** 一行输入（`order-shipping-rows` 投影里本层要用的那几列） */
export interface PulseRow {
  /**
   * 订单明细行 id（`oi_order_items.id`；0 / 缺省 = 没有行身份）。
   *
   * 2026-11-05 补：`orderStage` 要把这一批行喂给 `planCoverage` 算逐行覆盖度，
   * 而精确归属的匹配键就是它。宿主投影一直带着这个字段（`SELECT oi.id`），
   * 只是这一层之前没声明 —— 声明了才不会再有人"顺手"用单号去 join。
   */
  id?: number;
  orderNo: string;
  /** 平台状态原文（`oi_orders.biz_status`） */
  bizStatus: string;
  /** 最晚发货时点 `yyyy-mm-dd hh:mm:ss`（芒果 `sendGoodExpiredDate`，D-2 已定）；空串 = 不知道 */
  dealDeadline: string;
  /** 行图 id；0 = 没落地 */
  imageId: number;
  /** 行图的本地路径（空串 = 没有/没落地）。「待发货」清单出 32px 缩略图读它 */
  localPath?: string;
  /** 件数真值；null = 不知道（导入侧由渲染层解析，这里按 1 兜底并计数） */
  qty?: number | null;
  /** 店铺（订单级原文；清单第 2 列读它，空串 = 采集侧没记/未登记） */
  shop?: string;
  /** 款编码 / 款色（清单「图案」列的两段；都空 = 还没归类） */
  styleCode?: string;
  styleColor?: string;
  /**
   * 订单原文色 / 尺码（2026-11-05 补）。
   *
   * 「订单」屏要按**行**说清"还差什么"（款 · 色 · 码 × 件数），而颜色有回落顺序
   * （款色优先 → 订单原文色），尺码只存在于订单行上。回落顺序只在
   * `planCoverage` 里实现一次，这里只把两个原文都递下去。
   */
  color?: string;
  size?: string;
  /** 款色**身份**（`oi_style_colors.id`；0 = 未归类）—— 「图案状态」靠它判"图知道印在哪个款色上" */
  styleColorId?: number;
  /**
   * 订单行原始字段（报表整行保真）。
   *
   * ⚠️ 本层与 `orderStage` **都不读它**：件数只认 `qty` 列（缺失按 1）。
   * 让它参与件数计算就会出现"清单说 1 件、缺口按 3 件算"的分裂（见 `orderStage` 的注释）。
   * 声明在这里是为了让"传进来了但故意不用"成为**看得见的事实**，而不是让人以为漏了什么。
   */
  rawFields?: Record<string, string> | null;
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
 * 「图案状态」——清单最后一列。三档，与计划里的 `已绑/待绑/缺图` 一一对应。
 *
 * ⚠️ **M2 阶段的判据只有两个真实存在的列**：`image_id`（这行有没有图）与 `style_color_id`
 *    （这行的图/款色归类了没有）。所以：
 *      · `noImage` —— 没有行图。定制品没有买家图就**印不了**，这是唯一真正卡住的一档；
 *      · `unbound` —— 有图，但还没归到款色上：知道要印什么，但不知道印在哪个款/色/码；
 *      · `ready`   —— 图和款色都齐，可以进生产。
 *    M3 的 `pod_variant_patterns`（variant → 图案绑定）上线后，`ready` 会**再收紧一层**
 *    （"这款色默认印哪个图案"也查得到才叫 ready）—— 那时只改 `patternStateOf` 一处。
 *    在那之前把 `ready` 叫成"已绑"是准的：绑的就是**这一行**的图与款色。
 */
export type PatternState = 'ready' | 'unbound' | 'noImage';

export const PATTERN_STATE_LABEL: Record<PatternState, string> = {
  ready: '已绑',
  unbound: '待绑',
  noImage: '缺图',
};

/** 一行 = 一个订单商品行（一单多行会出现在多行，单号重复 —— 见 `ShippingQueue.orders`） */
export interface QueueLine {
  /** 订单明细行 id（`oi_order_items.id`；0 = 没有行身份）—— `orderStage` 拿它 join 覆盖度 */
  orderItemId: number;
  orderNo: string;
  shop: string;
  styleCode: string;
  styleColor: string;
  /** 款色身份（0 = 未归类）—— 与 `patternStateOf` 同一判据来源 */
  styleColorId: number;
  /** 订单原文色（款色为空时 `planCoverage` 回落用它；本层不自己回落） */
  color: string;
  size: string;
  /** 这一行的件数（`qty` 缺失按 1，并置 `assumedQty`） */
  pieces: number;
  assumedQty: boolean;
  imageId: number;
  /** 行图本地路径（空串 = 没图）。清单的缩略图列读它；不要在这里读盘 —— 读图在面板里合批做 */
  localPath: string;
  pattern: PatternState;
  /** 最晚发货时点（毫秒）；**0 = 不知道**（不是"很久以后"） */
  deadlineMs: number;
  /** 最晚发货时点原文（界面 title 用它，能自证"我读的是哪一列"） */
  deadlineRaw: string;
  /** 距截止还有多少毫秒（**负数 = 已超时**）；`NaN` = 不知道 */
  remainMs: number;
  /** 已过期 */
  overdue: boolean;
  /** 在 24h 窗口内（含已过期）—— 与 `ShippingPulse.risk` **同一判据** */
  risk: boolean;
}

export interface ShippingQueue {
  /** 按"最急在上"排好的行（无截止期的排在最后，见 `shippingQueue`） */
  lines: QueueLine[];
  /** 单数（按单号去重；**空单号不算一单**，与 `shippingPulse.pending` 同口径） */
  orders: number;
  /** 件数合计（= `shippingPulse.pieces`） */
  pieces: number;
  /** 有截止风险的单数（= `shippingPulse.risk`） */
  risk: number;
  /** 算不出截止风险的单数（没有截止期 / 格式认不出；= `shippingPulse.noDeadline`） */
  noDeadline: number;
}

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
 * 「还剩多久」的人话（清单第 5 列）。
 *
 * @param remainMs `deadline - now`（负数 = 已超时）；`NaN` = 不知道（没有截止期）
 *
 * 分档刻意粗糙：这一列是**排序与扫视**用的，不是秒表。四档之外再加精度只会让
 * "还剩 3 小时 2 分"和"还剩 3 小时 5 分"看起来是两个不同的处境 —— 它们不是。
 * ⚠️ 不知道 ≠ 还有很久：回落成「明天」或「—」都会让导入单看起来像"不着急"，
 *    而它们恰恰是这批里唯一算不出风险的那些。
 */
export function remainText(remainMs: number): string {
  if (!Number.isFinite(remainMs)) return '不知道';
  const late = remainMs <= 0;
  // ⚠️ **先归一成"总分钟"，再由它一次性拆 d/h/m**（2026-11-05 修）。
  //    旧实现每个档各自 `Math.round` 余数：59.6 分 ⇒ `0 小时 60 分`、29 天 23.7 小时 ⇒
  //    `29 天 24 小时` —— 单位溢出的文案会让人怀疑"这列到底对不对"，而这一列决定先发哪单。
  //    边界用例见 `tests/shippingQueue.spec.ts` 的「进位不能溢出」。
  const totalMin = Math.max(1, Math.round(Math.abs(remainMs) / 60000));
  let span: string;
  if (totalMin < 60) span = `${totalMin} 分钟`;
  else if (totalMin < 24 * 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    span = m >= 5 ? `${h} 小时 ${m} 分` : `${h} 小时`;
  } else {
    let d = Math.floor(totalMin / 1440);
    let h = Math.round((totalMin - d * 1440) / 60);
    // 进位：`totalMin` 落在 23.5h 之后时 `h` 会算成 24 ⇒ 并进 1 天，绝不输出「N 天 24 小时」
    if (h >= 24) {
      d += 1;
      h = 0;
    }
    span = h ? `${d} 天 ${h} 小时` : `${d} 天`;
  }
  return late ? `已超时 ${span}` : `还剩 ${span}`;
}

/** 一行的「图案状态」（判据见 `PatternState` 注释；M3 之后只改这一处） */
export function patternStateOf(row: { imageId?: unknown; styleColorId?: unknown } | null | undefined): PatternState {
  const img = Number(row?.imageId) || 0;
  if (!(img > 0)) return 'noImage';
  const sc = Number(row?.styleColorId) || 0;
  return sc > 0 ? 'ready' : 'unbound';
}

/**
 * 待发货清单：**只出待发货的行**，按"最急在上"排。
 *
 * 排序规则（两条，都要有）：
 *   ① 截止期升序（已过期的自然在最前 —— 它们 `remainMs < 0`）；
 *   ② **没有截止期的排在最后**。把它们当"最不急"排最前是错的（不知道 ≠ 不着急），
 *      按 0 排最前更错（0 会被当成"1970 年就到期"）。垫底 + 单元格写「不知道」是唯一诚实的做法。
 *
 * @param rows 订单行（**全库**投影，不是"今天导入的"——见文件头）
 * @param opts.now 当前时间（毫秒）；缺省取系统时间。**测的时候必须传**，否则断言会随运行时刻漂
 */
export function shippingQueue(
  rows: PulseRow[] | null | undefined,
  opts: { now?: number } = {},
): ShippingQueue {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const list = Array.isArray(rows) ? rows : [];
  const lines: QueueLine[] = [];
  /** 单号 → 该单**首行**的截止判定（单级判定"一单只算一次"：状态与截止期是订单级的列） */
  const orderDeadline = new Map<string, { deadlineMs: number; raw: string }>();

  for (const r of list) {
    if (!isWaitingShip(r?.bizStatus)) continue;
    const no = String(r?.orderNo ?? '');
    const deadlineMs = parseLocalTime(r?.dealDeadline);
    const raw = String(r?.dealDeadline ?? '');
    if (no && !orderDeadline.has(no)) orderDeadline.set(no, { deadlineMs, raw });

    const q = r?.qty;
    const n = typeof q === 'number' && Number.isFinite(q) && q > 0 ? Math.round(q) : 0;
    const imageId = Number(r?.imageId) || 0;
    lines.push({
      orderItemId: Number(r?.id) || 0,
      orderNo: no,
      shop: String(r?.shop ?? ''),
      styleCode: String(r?.styleCode ?? ''),
      styleColor: String(r?.styleColor ?? ''),
      styleColorId: Number(r?.styleColorId) || 0,
      color: String(r?.color ?? ''),
      size: String(r?.size ?? ''),
      pieces: n || 1,
      assumedQty: !n,
      imageId,
      localPath: String(r?.localPath ?? ''),
      pattern: patternStateOf({ imageId, styleColorId: r?.styleColorId }),
      deadlineMs,
      deadlineRaw: raw,
      remainMs: deadlineMs ? deadlineMs - now : NaN,
      // 单行上的 risk/overdue 用**本行**的截止期（同一单的各行理论上同值；不同值是数据坏了，
      // 那时显示坏的那一行比替它圆谎有用）
      overdue: deadlineMs ? deadlineMs <= now : false,
      risk: deadlineMs ? deadlineMs - now <= RISK_WINDOW_MS : false,
    });
  }

  // 稳定排序：先按截止期（未知垫底），再按**进入顺序**（SQL 是 `ORDER BY oi.id DESC`，
  // 同一单的多行本来就相邻）。用下标兜底而不是依赖引擎的稳定排序语义 —— 这条顺序
  // 是"最急的在最上"这个承诺的全部实现，不能押在引擎实现细节上。
  const idx = new Map<QueueLine, number>();
  lines.forEach((l, i) => idx.set(l, i));
  lines.sort((a, b) => {
    const ka = a.deadlineMs || Number.MAX_SAFE_INTEGER;
    const kb = b.deadlineMs || Number.MAX_SAFE_INTEGER;
    if (ka !== kb) return ka - kb;
    return (idx.get(a) ?? 0) - (idx.get(b) ?? 0);
  });

  let pieces = 0;
  for (const l of lines) pieces += l.pieces;
  // 风险与"算不出来"都是**单级**的，而且必须按**进入顺序**取首行（`orderDeadline` 是在排序前
  // 建好的）。若改成遍历排好序的 `lines`，同一单多行且截止期不一致（数据坏了）时会取到
  // "最早那个" —— 与 `shippingPulse` 旧口径不同，等于给坏数据附加了一层善意猜测。
  let risk = 0;
  let noDeadline = 0;
  for (const [, v] of orderDeadline) {
    if (!v.deadlineMs) {
      noDeadline += 1;
      continue;
    }
    if (v.deadlineMs - now <= RISK_WINDOW_MS) risk += 1;
  }
  return { lines, orders: orderDeadline.size, pieces, risk, noDeadline };
}

/**
 * 算第二行四数。**由 `shippingQueue` 汇总而来**（同一份实现，见文件头最后一段）。
 *
 * @param rows 订单行（**全库**投影，不是"今天导入的"——见文件头）
 * @param opts.now 当前时间（毫秒）；缺省取系统时间。**测的时候必须传**，否则断言会随运行时刻漂
 */
export function shippingPulse(
  rows: PulseRow[] | null | undefined,
  opts: { now?: number } = {},
): ShippingPulse {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const q = shippingQueue(rows, { now });
  const out: ShippingPulse = {
    pending: q.orders,
    risk: q.risk,
    pieces: q.pieces,
    missingImage: 0,
    noDeadline: q.noDeadline,
    assumedQty: 0,
  };
  // 缺图与"件数兜底"是**行级**的；单级的两个数（风险 / 算不出风险）已由 `shippingQueue`
  // 按"一单只算一次"算好。混在一起写就会出现"缺图 3 单"这种量纲错。
  for (const l of q.lines) {
    if (!(l.imageId > 0)) out.missingImage += 1;
    if (l.assumedQty) out.assumedQty += 1;
  }
  return out;
}
