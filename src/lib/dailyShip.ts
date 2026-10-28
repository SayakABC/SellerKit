// src/lib/dailyShip.ts
// 「发货台 › 总览」那四个数（2026-10-22）：今天要发几单 / 共几件 / 已拿几件 / 还差几件。
//
// 为什么单独一层：这四个数是**同一批订单行**上的三个口径（单、件、已拿），
// 任何一处各算一遍都会出现"这件算出 21 件、已拿算出 23 件"这类只有用户才发现的缝。
// 摘成纯函数才能被 vitest 直接钉住（DB 层受 Electron ABI 限制测不了）。
//
// **范围 = 传进来的这批行**（容器喂的是"今天导入的订单"，`orderShippingRows({importDate})`）：
//   · 已终结（关闭/取消/完成）的行**剔掉**并计数 —— 单已经没了，不发货；
//     ⚠️ 判据只能调 `bucketOfStatus`（唯一实现），别在这里另写一套 LIKE。
//   · 没有日期的行照收（不能拿"没日期"当"不发货"）。
//
// **件数** = `resolveQty`（与「统计」页、拣货单同一份：结算商品行真值 → 明细 qty → 报表
// `商品数量` → 按 1 件并计入 `assumedQty`）。缺件数**不静默**：界面按 `assumedQty` 说一句。
//
// **已拿** = 逐行覆盖（2026-10-22 起，不再是"款色码池子"）：
//   · 精确：`covered[订单行 id]` —— 来自 `purchase_sources.order_item_id`，是**事实**；
//   · 回退：加列之前的拿货单没有归属，走"无归属台账"池子按款色码先到先得（标 `estimated`）。
//   判定与「按单核对」清单**同一份实现**（`planCoverage`）—— 两处各算一遍，
//   总览说"全齐了"而清单说"还差 1 件"是必然会发生的。
//   `已拿 + 还差 === 件数` 必须恒成立 —— 这是这一屏唯一能自证的地方。
//
// ⚠️ 台账不记订单号的年代（2026-10-22 之前生成的历史拿货单）无法逐行归属，
//    那部分只能按款色码摊（`estimated`）。界面上必须说"含历史拿货，按总量估算"。
import type { CoverageInputRow, RowCoverage } from './orderCoverage';
import { planCoverage } from './orderCoverage';

/** 一行输入（宿主 `order-shipping-rows` / `purchase-order-coverage` 的投影里本层要用的那几列） */
export type DailyShipRow = CoverageInputRow;

export interface DailyShip {
  /** 去重订单号数（= 今天要发几单） */
  orders: number;
  /** 参与统计的订单行数 */
  rows: number;
  /** 需求件数（= 一共多少件商品） */
  pieces: number;
  /** 已拿件数（逐行覆盖：精确归属 + 无归属台账按款色码回退） */
  taken: number;
  /** 还差件数 = `pieces - taken`（恒等式，见文件头） */
  remaining: number;
  /** 件数按 1 件兜底的行数（> 0 时界面要说"件数可能偏小"，不静默） */
  assumedQty: number;
  /** 已终结（关闭/取消/完成）被剔掉的行数 */
  excludedFinished: number;
  /** 已拿里有"按款色码推算"的部分（历史拿货单没有订单归属）⇒ 界面要说明 */
  estimated: boolean;
}

/**
 * 算「今天要发」的四项。
 *
 * @param rows  今天导入的订单行（未筛选；本层剔已终结）
 * @param opts.covered 精确覆盖：`订单行 id → 已拿件数`（`purchase-order-coverage` 的 rows）
 * @param opts.pool    无归属台账（键 = `takenKeyOf`）；`opts.taken` 是同义旧名
 */
export function dailyShip(
  rows: DailyShipRow[] | null | undefined,
  opts: {
    covered?: Record<string, number> | null;
    pool?: Record<string, number> | null;
    /** 旧名（2026-10-22 之前：整个台账当池子）—— 与 `pool` 同义 */
    taken?: Record<string, number> | null;
  } = {},
): DailyShip {
  const plan = planCoverage(rows, { covered: opts?.covered, pool: opts?.pool ?? opts?.taken });
  const orderNos = new Set<string>();
  const out: DailyShip = {
    orders: 0,
    rows: plan.rows.length,
    pieces: 0,
    taken: 0,
    remaining: 0,
    assumedQty: plan.assumedQty,
    excludedFinished: plan.excludedFinished,
    estimated: false,
  };
  for (const r of plan.rows as RowCoverage[]) {
    out.pieces += r.qty;
    out.taken += r.covered;
    if (r.estimated) out.estimated = true;
    if (r.orderNo) orderNos.add(r.orderNo);
  }
  out.orders = orderNos.size;
  out.remaining = out.pieces - out.taken;
  return out;
}
