// src/lib/orderCoverage.ts
// 「这一行的货到底拿了没有」（2026-10-22）。
//
// 为什么需要这一层：`purchase_items` 的键是 `(拿货单, 款编码, 色, 码)` —— 同一款色码在一张
// 拿货单里只有一行，不管它背后是 3 条还是 30 条订单行。所以「填了拿货件数」表达的是
// "这个款色码的需求被满足了多少件"，**不是**"哪一条订单行已拿"。
// 一旦两条以上订单行共享同一款色码，就必须有分配顺序才能说清"谁齐了"。
//
// 分配顺序系统里早就有了（生成拿货单时 `purchase-db.autoSourceRows` 按 `oi_order_items.id`
// 先到先得），从 2026-10-22 起它把结论落进 `purchase_sources.order_item_id` ⇒ 归属成了**事实**。
// 本文件消费那份事实，只做两件事：
//   1. **精确**：`covered[orderItemId]` 直接就是这一行被覆盖的件数；
//   2. **回退**：加列之前的拿货单（`order_item_id = 0`）没有归属，交回给"无归属台账"池子，
//      按款色码、先到先得摊给它 —— 摊到的部分**必须标 `estimated`**，界面要说明是推算。
//
// ⚠️ 两段互斥、相加不重复：一件货要么有订单行归属（进了 `covered`），要么没有（进了池子）。
//    宿主 `orderCoverage()` 的 `unattributed` 已经减掉了有归属的那部分。
// ⚠️ 未识别款（款编码为空）**不摊池子**：空键会把"同色同码的不同商品"并成一格，
//    凭空宣布已拿是"漏货式"的静默错（货没到、界面说到了）。与 `outstanding()` 的 `have = 0` 同口径。
import { bucketOfStatus, dateKey, resolveQty } from './orderCost';
import { cutoffDate, takenKey, takenKeyOf } from './picking';

/** 一行输入：宿主 `orderCoverage().rows` 的投影（本层只取要用的列） */
export interface CoverageInputRow {
  /** 订单明细行 id（`oi_order_items.id`）—— 精确归属的匹配键 */
  id?: unknown;
  orderNo?: unknown;
  shop?: unknown;
  orderTime?: unknown;
  /**
   * 这一单**进入本地库的时间**（`oi_orders.created_at`，导入/采集落库时刻）。
   *
   * 与 `orderTime`（平台下单时刻）是**两件事**：芒果采集进来的单常常是前几天下、
   * 今天才抓到的（本机实测 4 单的下单日 10-24 ~ 11-01，采集日却是 11-02）。
   * 「这些数据是不是历史」问的是**入库日**，所以区间说明必须用这一列。
   */
  importedAt?: unknown;
  qty?: unknown;
  rawFields?: Record<string, string> | null;
  styleCode?: unknown;
  styleColor?: unknown;
  /** 订单原文色（款色为空时回落） */
  color?: unknown;
  size?: unknown;
  styleColorId?: unknown;
  bizStatus?: unknown;
  /** 宿主已算好的精确覆盖件数（同一行可能有多个来源行） */
  covered?: unknown;
  /** 这一行的色图（本地路径；宿主已按"款色代表图 → 本行订单图"取好） */
  imagePath?: unknown;
}

/** 一行的判定结果 */
export interface RowCoverage {
  orderItemId: number;
  orderNo: string;
  shop: string;
  orderTime: string;
  /** 入库时刻原文（见 `CoverageInputRow.importedAt`；与下单时刻不是同一件事） */
  importedAt: string;
  styleCode: string;
  /** 有效颜色（款色 → 订单原文色）—— 与拣货投影、拣货单同一顺序 */
  color: string;
  size: string;
  /** 需求件数（`resolveQty`：三档回落，缺件数按 1 并计入 `assumedQty`） */
  qty: number;
  /** 已覆盖件数 = 精确 + 池子摊到的（不超过 `qty`） */
  covered: number;
  /** `covered` 里含"无归属台账"摊过来的部分 ⇒ 是推算，不是事实 */
  estimated: boolean;
  /**
   * **没有款编码** —— 这行认不出是哪个商品，界面要标"齐没齐"不可信。
   *
   * ⚠️ 判据只看款编码，**不看 `style_color_id`**：老明细（加 `style_color_id` 之前导入的）
   * 有款编码、没有 id，靠文本键照样能对上台账（`takenKeyOf` 的文本分支就是为它们留的）。
   * 把 id=0 也算成"未识别"会让这批行永远摊不到台账 ⇒ 拿过的货又出现在待拿里。
   */
  unclassified: boolean;
  /** 这一行的色图（本地路径；'' = 没图）—— 按单核对要能看图，不只是读文字 */
  imagePath: string;
}

export interface CoveragePlan {
  /** 参与统计的行（已剔已终结） */
  rows: RowCoverage[];
  /** 已终结（关闭/取消/完成）被剔掉的行数 */
  excludedFinished: number;
  /** 件数按 1 件兜底的行数（> 0 时界面要说"件数可能偏小"） */
  assumedQty: number;
}

/**
 * 算每一行的覆盖件数。
 *
 * @param rows 订单明细行（未筛选；本层剔已终结）
 * @param opts.covered 明文【精确】：`orderItemId → 已覆盖件数`
 * @param opts.pool    明文【回退】：无归属台账，键 = `takenKeyOf(...)`；`opts.taken` 是同义旧名
 */
export function planCoverage(
  rows: CoverageInputRow[] | null | undefined,
  opts: {
    covered?: Record<string, number> | null;
    pool?: Record<string, number> | null;
    /** 旧名（2026-10-22 之前叫 `taken`：拿整条台账当池子）—— 与 `pool` 同义 */
    taken?: Record<string, number> | null;
  } = {}
): CoveragePlan {
  const list = Array.isArray(rows) ? rows : [];
  const coveredMap = opts?.covered && typeof opts.covered === 'object' ? opts.covered : {};
  const poolSrc = opts?.pool ?? opts?.taken;
  const pool: Record<string, number> =
    poolSrc && typeof poolSrc === 'object' ? { ...(poolSrc as Record<string, number>) } : {};

  const out: CoveragePlan = { rows: [], excludedFinished: 0, assumedQty: 0 };
  /** 池子按"先到先得"摊 —— 必须按订单行 id 升序（= 导入顺序），不能按传进来的顺序 */
  const byOrder: { row: RowCoverage; key: string }[] = [];

  for (const r of list) {
    if (bucketOfStatus(r?.bizStatus) === 'closed' || bucketOfStatus(r?.bizStatus) === 'completed') {
      out.excludedFinished += 1;
      continue;
    }
    const { qty, qtySource } = resolveQty({
      orderNo: r?.orderNo,
      qty: r?.qty,
      rawFields: r?.rawFields,
    });
    const id = Number(r?.id) || 0;
    const styleColorId = Number(r?.styleColorId) || 0;
    const styleCode = String(r?.styleCode ?? '');
    const color = String(r?.styleColor ?? '').trim() || String(r?.color ?? '');
    const size = String(r?.size ?? '');
    // id=0 的行没有订单行身份（正常数据里不该出现）⇒ 不给它匹配任何精确覆盖，
    // 否则一个手滑的 `covered["0"]` 会同时命中所有这类行（"已拿"凭空翻几倍）。
    const exact = id > 0 ? Math.max(0, Math.min(qty, Number(coveredMap[String(id)] ?? 0) || 0)) : 0;
    const row: RowCoverage = {
      orderItemId: id,
      orderNo: String(r?.orderNo ?? '').trim(),
      shop: String(r?.shop ?? ''),
      orderTime: String(r?.orderTime ?? ''),
      importedAt: String(r?.importedAt ?? ''),
      styleCode,
      color,
      size,
      qty,
      covered: exact,
      estimated: false,
      unclassified: !styleCode,
      imagePath: String(r?.imagePath ?? ''),
    };
    out.rows.push(row);
    if (qtySource === 'assumed') out.assumedQty += 1;
    // 还有缺口、且**有款色身份**的行才进池子队列（空款编码拼出的键会串商品）
    if (row.covered < row.qty && !row.unclassified) {
      byOrder.push({ row, key: takenKeyOf({ styleColorId, styleCode, color, size }) });
    }
  }

  // 先到先得：id 升序（id=0 的老行排最后，它们本来就没有可靠的先后）
  byOrder.sort((a, b) => {
    const ai = a.row.orderItemId || Number.MAX_SAFE_INTEGER;
    const bi = b.row.orderItemId || Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
  for (const { row, key } of byOrder) {
    let need = row.qty - row.covered;
    if (need <= 0) continue;
    // 一行可能同时命中两种台账键（带款色 id 的、老明细只有文本的）—— 两拨是**不同的单据行**，
    // 依次扣不会重复（与 `takenFrom` 的"两段相加"同一个道理）。
    const keys = key.startsWith('#') ? [key, takenKey(row.styleCode, row.color, row.size)] : [key];
    for (const k of keys) {
      if (need <= 0) break;
      const cur = Math.max(0, Number(pool[k]) || 0);
      if (cur <= 0) continue;
      const used = Math.min(need, cur);
      pool[k] = cur - used;
      row.covered += used;
      row.estimated = true;
      need -= used;
    }
  }

  return out;
}

/** 一张订单的覆盖情况（按订单号聚合） */
export interface OrderCoverageOrder {
  orderNo: string;
  shop: string;
  orderTime: string;
  /**
   * 这一单**入库的时刻**（同单所有明细行一致；'' = 宿主没给）。
   * 折叠头的「今天导入 / 历史导入」用它 —— 拿 `orderTime` 会答成"今天下单 0 单"。
   */
  importedAt: string;
  /** 明细行（还差的在前，齐了的在后 —— 用户先看见要动手的） */
  rows: RowCoverage[];
  pieces: number;
  covered: number;
  remaining: number;
  /** 全部行都覆盖满 ⇒ 可以发货 */
  done: boolean;
  /** 有任何一行用到"无归属台账"的推算 */
  estimated: boolean;
  /** 有任何一行没有款色归属 ⇒ "齐了"这个结论不可靠 */
  unclassified: boolean;
}

/** 把行级判定聚合成"每张订单齐没齐"（纯函数，顺序稳定：订单按最早下单在前） */
export function groupByOrder(rows: RowCoverage[] | null | undefined): OrderCoverageOrder[] {
  const list = Array.isArray(rows) ? rows : [];
  const map = new Map<string, OrderCoverageOrder>();
  for (const r of list) {
    const key = r.orderNo || `\u0000${r.orderItemId}`;
    let g = map.get(key);
    if (!g) {
      g = {
        orderNo: r.orderNo,
        shop: r.shop,
        orderTime: r.orderTime,
        importedAt: r.importedAt,
        rows: [],
        pieces: 0,
        covered: 0,
        remaining: 0,
        done: false,
        estimated: false,
        unclassified: false,
      };
      map.set(key, g);
    }
    g.rows.push(r);
    g.pieces += r.qty;
    g.covered += r.covered;
    if (r.estimated) g.estimated = true;
    if (r.unclassified) g.unclassified = true;
  }
  const out = [...map.values()];
  for (const g of out) {
    g.remaining = g.pieces - g.covered;
    g.done = g.remaining <= 0;
    // 还差的行在前（用户先看见要动手的），同组内按行 id 升序
    g.rows.sort(
      (a, b) =>
        Number(a.covered >= a.qty) - Number(b.covered >= b.qty) || a.orderItemId - b.orderItemId
    );
  }
  out.sort((a, b) => a.orderTime.localeCompare(b.orderTime) || a.orderNo.localeCompare(b.orderNo));
  return out;
}

export interface CoverageSummary {
  /** 未发货订单数 */
  orders: number;
  /** 齐了（可以发货）的订单数 */
  done: number;
  /** 还差货的订单数 */
  partial: number;
  /** 需求件数合计 */
  pieces: number;
  /** 已覆盖件数合计 */
  covered: number;
  /** 还差件数合计 */
  remaining: number;
  /** 有订单用到了"无归属台账"的推算 */
  estimated: boolean;
}

/** 顶部那句话用的汇总（数字全部来自 `groupByOrder` 的同一批对象，不另算一遍） */
export function coverageSummary(orders: OrderCoverageOrder[] | null | undefined): CoverageSummary {
  const list = Array.isArray(orders) ? orders : [];
  const out: CoverageSummary = {
    orders: list.length,
    done: 0,
    partial: 0,
    pieces: 0,
    covered: 0,
    remaining: 0,
    estimated: false,
  };
  for (const o of list) {
    if (o.done) out.done += 1;
    else out.partial += 1;
    out.pieces += o.pieces;
    out.covered += o.covered;
    out.remaining += o.remaining;
    if (o.estimated) out.estimated = true;
  }
  return out;
}

/**
 * 「按单核对」的时间窗结果（2026-11-02）。
 *
 * 为什么需要：折叠头原先只有「还差 73 单」一个数 —— 那是**全部未发货**（跨天结转，
 * 历史导入单也算在内），而总览的「今天同步 4 单」按导入日筛。两个数都真，但页面不说范围，
 * 用户只能理解成"今天同步出了 73 单"。这里把范围做成显式窗口，并把**被挡住的那批**
 * 报出去（`hidden` / `hiddenPieces`），不静默丢单。
 *
 * 口径与拣货宫格一致：按**下单日**（`dateKey(orderTime)`）；没有下单日的单**照收**
 * （"没日期"≠"太老"，丢掉会让货没人拣）。
 */
export interface CoverageWindow {
  /** 窗口内的单（界面上的「可以发货 / 还差」只用这一批） */
  visible: OrderCoverageOrder[];
  /** 窗口外的单（必须在界面上说"另有 N 单更早"，不许悄悄藏掉） */
  hidden: OrderCoverageOrder[];
  /** 窗口下界（yyyy-mm-dd）；'' = 不限 */
  cutoff: string;
  /** 窗口外那批的件数合计 */
  hiddenPieces: number;
}

export function scopeCoverageByDays(
  orders: OrderCoverageOrder[] | null | undefined,
  opts: { days?: unknown; today?: unknown } = {}
): CoverageWindow {
  const list = Array.isArray(orders) ? orders : [];
  const days = Number(opts?.days);
  const today = String(opts?.today ?? '');
  if (!(Number.isFinite(days) && days > 0) || !today) {
    return { visible: list, hidden: [], cutoff: '', hiddenPieces: 0 };
  }
  const cutoff = cutoffDate(today, days);
  if (!cutoff) return { visible: list, hidden: [], cutoff: '', hiddenPieces: 0 };
  const visible: OrderCoverageOrder[] = [];
  const hidden: OrderCoverageOrder[] = [];
  for (const o of list) {
    const day = dateKey(o.orderTime);
    if (!day || day >= cutoff) visible.push(o);
    else hidden.push(o);
  }
  const hiddenPieces = hidden.reduce((sum, o) => sum + o.pieces, 0);
  return { visible, hidden, cutoff, hiddenPieces };
}

/** 「今天导入 / 历史导入」的拆分（按 `importedAt`，不是下单日） */
export interface CoverageImportSplit {
  /** 入库日是今天（`today`）的订单数 */
  today: number;
  /** 入库日有、但不是今天的订单数（= 历史导入/采集） */
  history: number;
  /** 入库日认不出的订单数（照收、另说，不并进历史） */
  undated: number;
}

export function coverageImportSplit(
  orders: OrderCoverageOrder[] | null | undefined,
  today: unknown
): CoverageImportSplit {
  const list = Array.isArray(orders) ? orders : [];
  const key = String(today ?? '');
  const out: CoverageImportSplit = { today: 0, history: 0, undated: 0 };
  for (const o of list) {
    const day = dateKey(o.importedAt);
    if (!day) out.undated += 1;
    else if (day === key) out.today += 1;
    else out.history += 1;
  }
  return out;
}

/** 「还差什么」的单行文案（款 · 色 · 码 × 件数）—— 三处（按单清单 / 缺口 / 总览小字）共用一处拼法 */
export function missingLabel(row: RowCoverage): string {
  const name = row.styleCode || '未识别款';
  const color = row.color || '未分类';
  const size = row.size || '—';
  return `${name} · ${color} · ${size} × ${Math.max(0, row.qty - row.covered)}`;
}

/**
 * 把宿主 `purchase-order-coverage` 的原始返回压成 `planCoverage` 的入参。
 *
 * 为什么要有这一个函数：**键与列名只能有一处翻译**。
 *   · 线上列叫 `orderItemId`，纯函数内部叫 `id` —— 两处各翻译一遍，迟早有一处漏掉，
 *     那一处的行就永远"一件没拿"（而另一处说拿了，两个界面互相打脸）；
 *   · 台账键只能由 `takenKeyOf` 拼（与拿货清单、`takenLedger` 同一个函数）。
 *
 * 返回值可以直接整份喂给 `planCoverage(ins.rows, ins)`。
 */
export function coverageInputs(
  payload:
    | {
        rows?:
          | {
              orderItemId?: unknown;
              covered?: unknown;
              orderNo?: unknown;
              shop?: unknown;
              orderTime?: unknown;
              importedAt?: unknown;
              qty?: unknown;
              rawFields?: Record<string, string> | null;
              styleCode?: unknown;
              styleColor?: unknown;
              colorRaw?: unknown;
              size?: unknown;
              styleColorId?: unknown;
              imagePath?: unknown;
            }[]
          | null;
        unattributed?:
          | {
              styleColorId?: unknown;
              styleCode?: unknown;
              color?: unknown;
              size?: unknown;
              taken?: unknown;
            }[]
          | null;
      }
    | null
    | undefined
): { rows: CoverageInputRow[]; covered: Record<string, number>; pool: Record<string, number> } {
  const covered: Record<string, number> = {};
  const pool: Record<string, number> = {};
  const rows: CoverageInputRow[] = [];
  for (const r of payload?.rows ?? []) {
    const id = Number(r?.orderItemId) || 0;
    if (id <= 0) continue;
    covered[String(id)] = (Number(covered[String(id)]) || 0) + (Number(r?.covered) || 0);
    rows.push({
      id,
      orderNo: r?.orderNo,
      shop: r?.shop,
      orderTime: r?.orderTime,
      importedAt: r?.importedAt,
      qty: r?.qty ?? null,
      rawFields: r?.rawFields ?? {},
      styleCode: r?.styleCode,
      styleColor: r?.styleColor,
      // 宿主把「款色」与「订单原文色」分成两列（`styleColor` / `colorRaw`）——
      // 本层的 `color` 是**有效色**（款色优先、回落原文色），这样只有一处回落顺序。
      color: r?.colorRaw,
      size: r?.size,
      styleColorId: r?.styleColorId,
      // ⚠️ 故意**不给** `bizStatus`：`orderCoverage()` 的 SQL 已经排掉了已终结订单
      //    （`NOT TERMINAL_BIZ_STATUS_SQL`）。在这儿编一个"等待发货"会让
      //    "这行到底有没有被筛过"变成靠猜的 —— 缺省的 `''` 分桶是 `unknown`，
      //    `planCoverage` 不会二次剔除；真要二次剔除的是**带状态的行**（今天那批 shipping rows）。
      covered: r?.covered,
      // 色图跟着行走（款色代表图优先的结论已在宿主算好），本层只透传
      imagePath: r?.imagePath,
    });
  }
  for (const u of payload?.unattributed ?? []) {
    const k = takenKeyOf(u);
    pool[k] = (Number(pool[k]) || 0) + (Number(u?.taken) || 0);
  }
  return { rows, covered, pool };
}
