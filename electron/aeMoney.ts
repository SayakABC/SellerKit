// electron/aeMoney.ts
// 「采集订单（速卖通利润追踪）」的**金额/分摊/规格**纯函数层（零依赖：不碰 better-sqlite3 / electron）。
//
// 为什么单独成文件（与 `shopName.ts` / `orderMoney.ts` / `shopSku.ts` 同理由）：`ae-db.ts` / `ae-engine.ts`
// 依赖 Electron 的 Node ABI，进不了 vitest；而"行收入怎么分摊到行""退款科目怎么算""规格串怎么解析"
// 是这条链上唯一有正确性风险的东西，摘成零依赖模块后才能被 `tests/aeMoney.spec.ts` 直接覆盖。
//
// ⚠️ 它是**单一口径源**：`ae-engine.getProfitOverview`（岛「利润追踪」）与 `ae-db.collectedOrderRows`
// （统一订单投影，进 `src/lib/orderCost.ts` 那套模型）都必须调这里的函数 —— 两处各写一份分摊规则，
// 就会让"同一批采集订单"在两个页面显示两个数（这正是本轮重构要消灭的"多套"）。
//
// 口径（沿用 `docs/features/PROFIT_TRACKER.md` §4，本轮把"按 qty 近似"细化为"按行金额占比"）：
//   收入（原币）= 商品金额 + 买家付运费 − 退款/纠纷类科目
//   行收入（原币）= 行商品金额 ÷ 订单商品金额合计 × 订单收入；**行金额合计为 0 时回落按 qty 占比**
//   （行金额是真值，qty 只是"金额缺失时的近似"——原来一律按 qty 会把「1 件 198 元 + 1 件 12 元」摊成各半）

export {};

/** 退款/纠纷类费用科目 = 收入扣减（其余科目进费用侧）。**唯一一份**（ae-db / ae-engine 都从这里取） */
export const AE_DEDUCTION_CATEGORIES: ReadonlySet<string> = new Set([
  'refund',
  'dispute',
  'refund_amount',
]);

/** 订单收入（原币）= 商品金额 + 买家付运费 − 退款 */
export function orderIncomeCcy(input: {
  goodsAmount?: unknown;
  shippingIncome?: unknown;
  deductionAmount?: unknown;
}): number {
  return num(input?.goodsAmount) + num(input?.shippingIncome) - num(input?.deductionAmount);
}

/** 一行采集明细（`ae_order_lines` 的最小投影） */
export interface AeLineShareInput {
  qty?: unknown;
  goodsAmount?: unknown;
}

/**
 * 把订单收入按行分摊（原币）。
 *
 * 规则：**优先按行商品金额占比**；行金额合计 ≤ 0（脏数据/未采集金额）时回落**按 qty 占比**；
 * 两者都不可用时平分（保证 Σ = 订单收入，不吞钱也不生钱）。
 * @returns 与入参等长的行收入数组（Σ = `incomeCcy`）
 */
export function lineIncomeShares(lines: readonly AeLineShareInput[] | null | undefined, incomeCcy: unknown): number[] {
  const list = Array.isArray(lines) ? lines : [];
  const income = num(incomeCcy);
  if (!list.length) return [];
  const goods = list.map((l) => num(l?.goodsAmount));
  const goodsSum = goods.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (goodsSum > 0) return goods.map((g) => (income * (g > 0 ? g : 0)) / goodsSum);
  const qtys = list.map((l) => Math.max(0, num(l?.qty)));
  const qtySum = qtys.reduce((a, b) => a + b, 0);
  if (qtySum > 0) return qtys.map((q) => (income * q) / qtySum);
  const even = income / list.length;
  return list.map(() => even);
}

/**
 * 采集来的规格串 → 颜色 / 尺码。
 *
 * 实测写法（本机库 101 单）：`Picture color+XXXL+China Mainland`（`+` 分隔的「颜色+尺码+发货地」），
 * 也见 `Color:Red;Size:L`。解析**只认能确定的**：认不出就返回空串（由上层标缺口，不猜）。
 */
export function parseSkuProps(raw: unknown): { color: string; size: string; shipsFrom: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { color: '', size: '', shipsFrom: '' };
  // 形式一：`Color:Red;Size:L` / `Size:L,Color:3`
  const kv = new Map<string, string>();
  for (const part of s.split(/[;；,，]/)) {
    const m = /^\s*([A-Za-z ]+?)\s*[:：]\s*(.+?)\s*$/.exec(part);
    if (m) kv.set(m[1].trim().toLowerCase(), m[2]);
  }
  const color = kv.get('color') ?? kv.get('colour') ?? '';
  const size = kv.get('size') ?? '';
  if (color || size) return { color, size, shipsFrom: kv.get('ships from') ?? '' };
  // 形式二：`+` 分隔（速卖通采集帧）：颜色+尺码+发货地 —— 尺码可辨认（S/M/L/XL/XXL/数字…）
  const parts = s.split('+').map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const sizeIdx = parts.findIndex((p) => /^(\d{2,3}|[XSML]{1,3}L?|XXXL|XXL|XL|XS|S|M|L)$/i.test(p));
    const shipsIdx = parts.findIndex((p) => /china|united states|spain|russia/i.test(p));
    const size = sizeIdx >= 0 ? parts[sizeIdx] : '';
    const shipsFrom = shipsIdx >= 0 ? parts[shipsIdx] : '';
    const color = parts.filter((_, i) => i !== sizeIdx && i !== shipsIdx).join(' ') || '';
    return { color, size, shipsFrom };
  }
  return { color: '', size: '', shipsFrom: '' };
}

/**
 * 原币金额 × 汇率 → **分**（CNY 整数）。汇率缺失/非正 → `null`（**不要折成 0**：
 * 0 会让"缺汇率"看起来像"这笔钱是零"，与 `orderMoney` 的空值纪律一致）。
 */
export function toCentsCny(amountCcy: unknown, rateToCny: unknown): number | null {
  const amount = num(amountCcy);
  const rate = num(rateToCny);
  if (!Number.isFinite(amount) || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(amount * rate * 100);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}