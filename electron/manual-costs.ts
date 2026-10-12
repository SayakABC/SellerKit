// electron/manual-costs.ts
// **手工进价的写入口径**（`ae_cost_map` 的 `source='manual'` 那一批）。
//
// 两个调用方，同一份口径 —— 这就是它单独成文件的原因：
//   · 产品导入（Excel 模板的「进价」列）→ `product-handlers.ts`
//   · 成本维护界面（「货与成本 › 成本」逐款录入）→ `ae-handlers.ts`
// 两处若各写一份"值相同就不写"的判断，必然漂开：一处写了冗余区间行、另一处不写，
// 而界面上两边都显示"保存成功"。
//
// 为什么写 manual 而不是 purchase：`purchase` 是**拿货对账自动同步**的产物
// （`purchase-cost-sync.ts`，每次落账全量替换那一批）—— 手工录的价必须落在
// `manual` 上，才不会被下一次对账同步抹掉（D5 的原始事实）。读取侧 manual 优先。
//
// 幂等：与库内该款**最新的 manual 价**相同则跳过 —— 否则「导出 → 原样导回」或
// "重复点保存"每天都会新增一条区间行（值没变，纯膨胀）。
export {};

import { costMapList, costMapUpsertManual } from './ae-db';

/** 待写入的手工进价（一条 = 一个款的一个生效区间） */
export interface ManualCostInput {
  /** 款编码（= `ae_cost_map.style_code`，产品域与成本域唯一的锚点） */
  code: string;
  /** 款式名（可选，写进 `style_name` 供成本表展示） */
  name?: string;
  /** 进价（分） */
  costCents: number;
  /**
   * 生效日 `yyyy-mm-dd`。缺省 = 今天（`effectiveFrom` 参数）。
   * 界面允许填更早的日期 ⇒ **补录历史价**（区间口径的正当用法）。
   */
  effectiveFrom?: string;
}

/** 本地日期 `yyyy-mm-dd`（生效日缺省值 = 今天） */
function todayKey(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** `yyyy-mm-dd` 形状校验（年月日的语义合法性交给 SQLite 的比较，这里只挡形状） */
function isDateKey(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * 把一批手工进价写进 `ae_cost_map`（`source='manual'`）。
 *
 * ⚠️ 生效日只能取**今天或用户显式给的日期**，**绝不回落** `COST_LEGACY_FROM`（`0000-01-01`）：
 *    那会把该款**所有历史订单**的成本一起改成新价。"缺省"在这里等于"今天"，不是"最早"。
 *
 * @param items 待写入的进价；非有限数 / 空编码的行**跳过**（调用方无须预筛）
 * @param effectiveFrom 缺省生效日 `yyyy-mm-dd`；非法或缺失 → 当天
 * @returns `written` 真正写入的条数 / `skipped` 因与现价相同或无效而跳过的条数
 */
export function applyManualCosts(
  items: ManualCostInput[],
  effectiveFrom: string,
): { written: number; skipped: number } {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { written: 0, skipped: 0 };

  const rawDefault = String(effectiveFrom ?? '').trim();
  const fallback = isDateKey(rawDefault) ? rawDefault : todayKey();

  // 每款「最新 manual 价」（`effective_from` 最大者）—— 幂等基线。
  // 只比 manual 不比 purchase：手工填的就是 manual 语义；库里只有 purchase 行时照样写一条 manual
  // （读取侧 manual 优先，结果一致）。
  const latestFrom = new Map<string, string>();
  const latestCents = new Map<string, number>();
  for (const row of costMapList()) {
    if (row.source !== 'manual' || !row.styleCode) continue;
    const prev = latestFrom.get(row.styleCode);
    if (prev === undefined || row.effectiveFrom > prev) {
      latestFrom.set(row.styleCode, row.effectiveFrom);
      latestCents.set(row.styleCode, Number(row.unitPriceCents) || 0);
    }
  }

  const todo: {
    styleCode: string;
    styleName: string;
    unitPriceCents: number;
    sampleCount: number;
    effectiveFrom: string;
    lastBizDate: string;
  }[] = [];
  let skipped = 0;
  for (const it of list) {
    const code = String(it?.code ?? '').trim();
    const n = Number(it?.costCents);
    if (!code || !Number.isFinite(n) || n < 0) {
      skipped++;
      continue;
    }
    const cents = Math.round(n);
    const own = String(it?.effectiveFrom ?? '').trim();
    const from = isDateKey(own) ? own : fallback;

    // 幂等：与**最新 manual 价**相同则不写。
    // 刻意**不看** `from` 是早是晚：补一条"值与现价相同的历史区间"没有收益 —— 区间回查
    // （`pickUnitCost`）在没有更早区间时会回落到最早那条，结果一样；写了只是多一行冗余。
    if (latestCents.get(code) === cents) {
      skipped++;
      continue;
    }
    todo.push({
      styleCode: code,
      styleName: String(it?.name ?? '').trim(),
      unitPriceCents: cents,
      sampleCount: 0,
      effectiveFrom: from,
      lastBizDate: from,
    });
  }

  if (todo.length) costMapUpsertManual(todo);
  return { written: todo.length, skipped };
}
