// src/lib/orderStage.ts
// 「每张订单准备到哪一档」—— 发货台「订单」屏的唯一判定层（2026-11-05）。
//
// 为什么要有这一层（用户原话）：
//   「发货台准确的定位应该是发货前的准备工作，准备完成，就代表这个订单已经完成了准备，
//     所以怎么才能以订单维度来跟踪当前订单的状态。现在的流程感觉是相对独立的，让人看不太明白」
//
// 原先是**一条全局流水线**（导入 → 归类 → 拿货 → 对账）当主结构：页签上只有一处「当前步」，
// 它答的是"整批"，而用户问的是"我这几单"。真实处境是四类活同时压在四张不同的单上
// （A 单差 1 件 / B 单已齐 / C 单缺图 / D 单没认出色）—— 串行模型表达不了并存。
//
// 本层只做一件事：**给每张订单算一个"准备到哪一档"**，全部由已有事实派生。
//
// 三条硬规矩（都踩过坑，别改）：
//   ① **零新增字段、零新增 IPC**。输入就是容器已经取到的两份：`order-shipping-rows`（行投影，
//      带 `oi_order_items.id` 与 `image_id`）与 `purchase-order-coverage`（逐行已拿件数）。
//      加一列 `stage` 就要有四处回写路径（归类 / 拿货 / 平台同步 / 手工），漏一处就产生
//      "库里的状态与事实不符"，而且没人能一眼看出哪边对（`ship_time` 就是现成的反例：
//      它至今没有任何回写路径）。
//   ② **判据复用，不重写**：行级图案三档用 `shippingPulse.patternStateOf`、件数与已拿用
//      `orderCoverage.planCoverage`、平台状态分桶用 `mangoStatus.isWaitingShip`。
//      同一件事两套实现 = 两屏数字打架（本项目已有 3 次实证）。
//   ③ **读不到 ≠ 已备齐**。覆盖度取不到、或这一行没有订单行身份（`id = 0`，join 不上）时，
//      档位必须落 `unknown`（界面词「待核对」），**不许默认完成** —— 默认完成会让用户当天
//      少发一批货，而界面上看起来一切正常。
//
// 关于「已发出」：它**不是一档**。待发货清单本身只收 `isWaitingShip` 的行
// （见 `shippingQueue`），所以在平台上已经发货的单**根本不在这个队列里** —— 这正是它
// 该有的行为（自动离队），不必也不能再给它一个恒为 0 的档位。反过来说：本队列里的单
// 都是"平台还没发"的，`ship_time` 至今没有回写路径（`docs/notes` 已取证），所以
// 「已备齐」的单会一直留着，直到回芒果发货后重新采集。界面必须把这句话说出来。
import { isWaitingShip } from './mangoStatus';
import { planCoverage, type CoverageInputRow } from './orderCoverage';
import {
  shippingQueue,
  type PatternState,
  type PulseRow,
  type QueueLine,
} from './shippingPulse';

/**
 * 订单准备档。
 *
 * 阶梯顺序 = **卡得死不死**（不是"流程第几步"）：没有买家图根本印不了；有图但没归到款色
 * 就不知道该拿什么；知道拿什么但货不够；都齐了才能发。
 *
 * `unknown` 不是"第五种业务状态"，而是**判不出来**（读不到覆盖度）—— 它单独一档是为了
 * 让"不知道"在界面上有地方站，而不是被塞进 `ready`（危险）或 `waitingStock`（误导）。
 */
export type OrderStage = 'noImage' | 'unclassified' | 'waitingStock' | 'unknown' | 'ready';

/** 界面词（**唯一来源**：面板与断言都读这里，别各写一份） */
export const ORDER_STAGE_LABEL: Record<OrderStage, string> = {
  noImage: '缺图',
  unclassified: '待归类',
  waitingStock: '待拿货',
  unknown: '待核对',
  ready: '已备齐',
};

/**
 * 分组顺序（界面上的四格）。刻意**不含 `unknown`**：
 * 它是异常路径（覆盖度读不到），正常情况下恒为 0；把它摆成第五格会让每天都要扫一眼的
 * 四个数变成五个，而其中一个是几乎永远为 0 的 —— 那就是噪音。它单独一行提示，见 `counts`。
 */
export const ORDER_STAGE_ORDER: OrderStage[] = [
  'noImage',
  'unclassified',
  'waitingStock',
  'ready',
];

/** 阶梯排名（越小越"卡得死"）。**订单档 = 所有明细行里排名最靠前的那一档**（木桶） */
const STAGE_RANK: Record<OrderStage, number> = {
  noImage: 0,
  unclassified: 1,
  // `waitingStock` 排在 `unknown` 前面：一组行里只要有一行**确定**差货，这单就确实还差货，
  // 那是个可以立刻动手的结论 —— 不该被另一行的"读不到"降级成"待核对"。
  waitingStock: 2,
  unknown: 3,
  ready: 4,
};

/** 一行（= 一条订单商品行）的准备情况 */
export interface OrderStageLine {
  /** `oi_order_items.id`；0 = 没有行身份（join 不上覆盖度） */
  orderItemId: number;
  styleCode: string;
  color: string;
  size: string;
  /** 需求件数（与 `shippingPulse.shippingQueue` 同一取值：`qty` 缺失按 1） */
  qty: number;
  /** 已拿件数；**`null` = 读不到**（覆盖度取不到 / 没有行身份），不是 0 */
  covered: number | null;
  /** 还差几件；`null` = 不知道（同上） */
  gap: number | null;
  pattern: PatternState;
  /** 行图本地路径（'' = 没图）—— 面板合批读缩略图用它 */
  imagePath: string;
  /** 这一行自己卡在哪 */
  stage: OrderStage;
  /** 件数是按 1 兜底的（界面要标出来，别让它看起来像个确定的数） */
  assumedQty: boolean;
  /** `covered` 里含"无归属台账"摊过来的部分 ⇒ 是推算，不是事实 */
  estimated: boolean;
}

/** 一张订单的准备情况（订单档 = `lines` 里最差的那一行） */
export interface OrderStageOrder {
  orderNo: string;
  shop: string;
  /** 件数合计 */
  pieces: number;
  /** 还差件数合计（`unknown` 的行不计入 —— 见 `gapUnknown`） */
  gap: number;
  /** 有行的缺口**算不出来**（覆盖度缺）⇒ 界面上的"还差 N 件"是偏小的，要说明 */
  gapUnknown: boolean;
  /** 最晚发货时点（毫秒）；**0 = 不知道**（不是"很久以后"） */
  deadlineMs: number;
  /** 最晚发货原文（title 用它自证"读的是哪一列"） */
  deadlineRaw: string;
  /** 距截止还有多少毫秒（负数 = 已超时）；`NaN` = 不知道 */
  remainMs: number;
  overdue: boolean;
  /** 在 24h 窗口内（含已过期）—— 与 `shippingPulse` 同一判据 */
  risk: boolean;
  /** 订单档 */
  stage: OrderStage;
  /** 明细行（卡住的行在前，同档按行 id 升序） */
  lines: OrderStageLine[];
  /** 卡住的行数（= `lines` 里非 `ready` 的行数）；界面用它说"3 行里 1 行缺图" */
  blocked: number;
}

/** 一档的计数（四档之和 + `unknown` = `shippingPulse.pending`，这是本层的核心不变式） */
export type OrderStageCounts = Record<OrderStage, number>;

export interface OrderStagePlan {
  /** 订单清单（按最晚发货时间排，没有截止期的垫底 —— 与待发货清单同一套顺序） */
  orders: OrderStageOrder[];
  counts: OrderStageCounts;
  /**
   * 覆盖度是不是**读到了**。
   *
   * `false` = 这一次 `purchase-order-coverage` 失败 ⇒ 所有订单落 `unknown`。
   * 界面必须据此说明"读不到拿货记录"，而不是显示成"货都齐了"或"一件没拿"。
   */
  coverageKnown: boolean;
}

/** 空的四档计数（面板初始值 / 测试夹具都用它，别在别处再手写一遍） */
export function emptyStageCounts(): OrderStageCounts {
  return { noImage: 0, unclassified: 0, waitingStock: 0, unknown: 0, ready: 0 };
}

/**
 * 一行的档位。
 *
 * 顺序就是优先级：**图 > 款色 > 货**。
 *   · 没图 ⇒ `noImage`（再谈拿货没有意义：印不了）；
 *   · 有图没款色 ⇒ `unclassified`（不知道该拿哪个款色）；
 *   · 覆盖度读不到 ⇒ `unknown`（**不填 0**，见文件头第 ③ 条）；
 *   · 拿到的不够 ⇒ `waitingStock`；
 *   · 其余 ⇒ `ready`。
 */
function lineStageOf(pattern: PatternState, covered: number | null, qty: number): OrderStage {
  if (pattern === 'noImage') return 'noImage';
  if (pattern === 'unbound') return 'unclassified';
  if (covered === null) return 'unknown';
  return covered < qty ? 'waitingStock' : 'ready';
}

/**
 * 算整份「订单 → 档位」。
 *
 * @param rows 订单行投影（**全库**，不是"今天导入的" —— 待发货跨天结转，与 `shippingQueue` 同源）
 * @param opts.covered 明文【精确】：`orderItemId → 已覆盖件数`（宿主 `purchase-order-coverage`）
 * @param opts.pool    明文【回退】：无归属台账（加 `order_item_id` 之前的拿货单），键 = `takenKeyOf(...)`
 * @param opts.coverageKnown `false` ⇒ 覆盖度这一次没读到（失败）。缺省 `true`
 * @param opts.now     当前时间（毫秒）。**测的时候必须传**，否则断言随运行时刻漂
 */
export function orderStages(
  rows: PulseRow[] | null | undefined,
  opts: {
    covered?: Record<string, number> | null;
    pool?: Record<string, number> | null;
    coverageKnown?: boolean;
    now?: number;
  } = {}
): OrderStagePlan {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const coverageKnown = opts.coverageKnown !== false;

  // ① 只出待发货的行，顺序 = 最急在上（**唯一实现**在 `shippingQueue`，这里不重排 ——
  //    重排就是第二套排序：哪天那边改了，两屏顺序会悄悄不一致）。
  const q = shippingQueue(rows, { now });

  // ② 逐行覆盖度：**同一批行**喂给 `planCoverage`。
  //
  // ⚠️ `qty` 直接给 `l.pieces`（= `shippingQueue` 的取法），并把 `rawFields` 传空：
  //    `resolveQty` 会走 `own >= 1` 那条分支，于是件数**只有一处口径**。
  //    若让它去解析 `rawFields`，同一行会出现"清单说 1 件、缺口按 3 件算"的分裂
  //    （导入单的 qty 列是 NULL，而报表原文里可能写着 3）。
  // ⚠️ 故意**不给** `bizStatus`：`shippingQueue` 已用 `isWaitingShip` 筛过，这一批不可能
  //    是已终结状态；再给一个状态会让"到底筛过没筛过"变成要靠猜的。
  const inputs: CoverageInputRow[] = q.lines.map((l) => ({
    id: l.orderItemId,
    orderNo: l.orderNo,
    qty: l.pieces,
    rawFields: {},
    styleCode: l.styleCode,
    styleColor: l.styleColor,
    color: l.color,
    size: l.size,
    styleColorId: l.styleColorId,
    imagePath: l.localPath,
  }));
  // `planCoverage` 按入参顺序输出（只跳过已终结状态，而这一批里没有），所以下标能对齐。
  // 万一哪天它对不齐（实现变了），下面的 `?? null` 会把那一行降级成"读不到"而不是
  // 静默拿错一行的件数 —— 错位比缺失更难发现。
  const cov = coverageKnown
    ? planCoverage(inputs, { covered: opts.covered, pool: opts.pool }).rows
    : [];
  const covAt = (i: number, l: QueueLine): { covered: number | null; estimated: boolean } => {
    if (!coverageKnown) return { covered: null, estimated: false };
    // 没有行身份的行 join 不上任何精确归属 ⇒ 只能算"不知道"，不许当 0（当 0 会把
    // "我拿过了"说成"还差"，用户会重复下单）。
    if (!(l.orderItemId > 0)) return { covered: null, estimated: false };
    const c = cov[i];
    if (!c || c.orderItemId !== l.orderItemId) return { covered: null, estimated: false };
    return { covered: c.covered, estimated: c.estimated };
  };

  // ③ 按单聚合。`q.lines` 已按截止期排好 ⇒ 首次出现的那一行就是这一单最急的一行，
  //    订单顺序因此天然是"最急在上"，不需要再排一遍。
  const counts = emptyStageCounts();
  const byNo = new Map<string, OrderStageOrder>();
  const order: OrderStageOrder[] = [];

  q.lines.forEach((l, i) => {
    const { covered, estimated } = covAt(i, l);
    const gap = covered === null ? null : Math.max(0, l.pieces - covered);
    const stage = lineStageOf(l.pattern, covered, l.pieces);
    const line: OrderStageLine = {
      orderItemId: l.orderItemId,
      styleCode: l.styleCode,
      color: l.color || l.styleColor,
      size: l.size,
      qty: l.pieces,
      covered,
      gap,
      pattern: l.pattern,
      imagePath: l.localPath,
      stage,
      assumedQty: l.assumedQty,
      estimated,
    };

    // 没有单号的行也得能显示（否则"这一条数据有问题"会被静默吞掉）—— 用行 id 当键，
    // 与 `orderCoverage.groupByOrder` 同一个办法。
    const key = l.orderNo || `\u0000${l.orderItemId || i}`;
    let g = byNo.get(key);
    if (!g) {
      g = {
        orderNo: l.orderNo,
        shop: l.shop,
        pieces: 0,
        gap: 0,
        gapUnknown: false,
        deadlineMs: l.deadlineMs,
        deadlineRaw: l.deadlineRaw,
        remainMs: l.remainMs,
        overdue: l.overdue,
        risk: l.risk,
        stage: 'ready',
        lines: [],
        blocked: 0,
      };
      byNo.set(key, g);
      order.push(g);
    }
    g.lines.push(line);
    g.pieces += l.pieces;
    if (gap === null) g.gapUnknown = true;
    else g.gap += gap;
    // 木桶：订单档取排名最靠前的那一行
    if (STAGE_RANK[stage] < STAGE_RANK[g.stage]) g.stage = stage;
    // 截止期取**最急的一行**（同单多行理论上同值；不同值是数据坏了，显示更急的那个比
    // 替它圆谎有用 —— 与 `shippingQueue` 行级 `risk/overdue` 的取舍一致）
    if (l.deadlineMs && (!g.deadlineMs || l.deadlineMs < g.deadlineMs)) {
      g.deadlineMs = l.deadlineMs;
      g.deadlineRaw = l.deadlineRaw;
      g.remainMs = l.remainMs;
      g.overdue = l.overdue;
      g.risk = l.risk;
    }
  });

  for (const g of order) {
    g.blocked = g.lines.filter((x) => x.stage !== 'ready').length;
    // 卡住的行在前（用户先看见要动手的），同档按行 id 升序（= 导入顺序，稳定）
    g.lines.sort(
      (a, b) => STAGE_RANK[a.stage] - STAGE_RANK[b.stage] || a.orderItemId - b.orderItemId
    );
    counts[g.stage] += 1;
  }

  return { orders: order, counts, coverageKnown };
}

/**
 * 四档之和（**不含 `unknown`**）+ `unknown` 必须等于待发货单数。
 *
 * 抽成函数是为了让面板与断言读**同一个算式**：面板上写"合计 N 单"、四格加起来却是 N+1，
 * 用户会怀疑整屏数字（而这正是"总览说 3 单、清单列 2 行"那类缝的同一个病）。
 */
export function stageTotal(counts: OrderStageCounts | null | undefined): number {
  if (!counts) return 0;
  return (
    (counts.noImage || 0) +
    (counts.unclassified || 0) +
    (counts.waitingStock || 0) +
    (counts.ready || 0) +
    (counts.unknown || 0)
  );
}

/**
 * 订单行上的"还差什么"一句话（款 · 色 · 码 × 件数）。
 *
 * 与 `orderCoverage.missingLabel` 的分工：那个吃 `RowCoverage`（拿货页的按单核对用），
 * 这个吃 `OrderStageLine`。两处都只有一处拼法，不在模板里各拼一遍 —— 否则同一行
 * 在两屏上会长得不一样，用户以为看到了两条数据。
 */
export function stageLineLabel(l: OrderStageLine): string {
  const name = l.styleCode || '未识别款';
  const color = l.color || '未分类';
  const size = l.size || '—';
  const tail = l.gap === null ? '件数未知' : l.gap > 0 ? `还差 ${l.gap}` : '已齐';
  return `${name} · ${color} · ${size} × ${l.qty}（${tail}）`;
}

/** 「这一档该做什么」—— 界面上的动作动词只在这里写一次（面板、断言、提示共用） */
export const ORDER_STAGE_ACTION: Record<OrderStage, string> = {
  noImage: '回芒果重抓',
  unclassified: '去归类',
  waitingStock: '去拿货',
  unknown: '去核对',
  ready: '去芒果发货',
};

/** 平台状态这一单是不是"还等我发货"（面板判空态用；唯一实现仍在 `mangoStatus`） */
export function isPendingOrder(bizStatus: unknown): boolean {
  return isWaitingShip(bizStatus);
}
