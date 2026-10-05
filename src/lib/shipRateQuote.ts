// src/lib/shipRateQuote.ts
// 「无忧物流运费」的**计价**半场：归一化运价表 → 按克重算出到各国的运费。
//
// 与 src/lib/shipRate.ts 的分工（两者合起来才是完整业务域，拆开只为各自职责单一）：
//   shipRate.ts       报价单 Excel → 运价表（解析 / 归一化，吃的是表格版式）
//   shipRateQuote.ts  运价表 → 运费（选卡 / 计价 / 取整，吃的是业务参数）
//
// 为什么计价也在宿主而不是岛里（岛自己算就不用每次把运价表传回宿主了）：
//   ① 取整口径、档位边界、类别优先级这三处**只要有两份实现就一定会漂移**，
//      而它们都直接影响"客户看到的金额"；
//   ② 岛运行在 iframe 内（不打包依赖、CSP 无 unsafe-eval），没有构建步骤，
//      复制一份纯算术逻辑进去就等于引入一个永远不会被测试覆盖的副本。
//   代价是每次查询要把运价表传回宿主 —— 实测整表约 1.3 万节点，远低于
//   payloadBudget 的 5 万节点预算（tests/shipRate.spec.ts 有断言钉住）。
//
// ⚠️ 本文件对**非人民币**价卡明确拒算（见 QUOTE_CURRENCY）：报价单里有线路按美元计价，
//    本模型没有汇率来源，宁可让它在界面上显示"未换算"，也不套人民币的壳给出错金额。

import {
  BASE_G,
  BULK_MAX_G,
  SMALL_MAX_G,
  STEP_G,
  type Category,
  type ChargeMode,
  type CountryRate,
  type Currency,
  type RateCard,
  type RateTable,
  type Rounding,
} from './shipRate';

/**
 * 本域唯一的计价币种。
 *
 * ⚠️ 报价单里**不是所有线路都按人民币报价**：`超级经济`、`无忧物流-特惠` 的表头写的是
 * `美元（USD）/KG`。本模型没有汇率来源（见 SHIPPING_RATE_ISLAND_PLAN §8），
 * 所以对非本币价卡**明确拒算**，而不是套人民币的壳给出一个差 7 倍的金额。
 * 拒算在界面上立刻可见；错价不会。
 */
export const QUOTE_CURRENCY: Currency = 'CNY';

/** 币种 → 拒算原因文案 */
const CURRENCY_REFUSAL: Record<string, string> = {
  USD: '该线路以美元（USD）报价，尚未接入汇率，未换算',
  '': '该价卡未标注币种，口径不明，不予计价',
};

export interface QuoteOptions {
  /** 'auto'（默认）按克重判定；指定类别则强制使用该类 */
  category?: Category | 'auto';
  /** 非普货的仓库变体；指定后该国没有该变体价卡即视为无价 */
  variant?: string;
  rounding?: Rounding;
}

export interface QuoteBreakdown {
  delivery: number;
  register: number;
  first: number;
  extra: number;
  /** 取整前的金额 */
  raw: number;
  /** 实际据以计费的克重（已套用该价卡的最低计费重量） */
  chargeG: number;
}

/** 某国可用档位摘要（无可用价时回给 UI，让用户知道该国到底支持哪些重量） */
export interface CandidateSummary {
  minG: number;
  maxG: number;
  categories: Category[];
  mode: ChargeMode;
  variant: string;
}

export interface QuoteRow {
  code: string;
  nameCn: string;
  nameEn: string;
  ok: boolean;
  /** ok=false 时的原因 */
  reason: string;
  fee: number;
  breakdown: QuoteBreakdown | null;
  category: Category | null;
  variant: string;
  card: RateCard | null;
  candidates: CandidateSummary[];
}

/** 合法类别白名单（岛传来的字符串不可信，红线 3）。`any` = 该表不分品类，任何类别查询都可命中 */
const CATEGORIES: readonly Category[] = ['general', 'special', 'bulk', 'any'];

export function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
}

/**
 * 选价卡：先按类别优先级过滤"克重落在档位内"的卡，再按变体收敛。
 *
 * 类别优先级 —— 强制类别时只用该类别；自动时 ≤2kg 优先普货（最常见），
 * >2kg 直接走大包（报价单口径：小包上限 2kg）。
 * `any` 一律排在最后：它代表"这张表不分品类"（燕文 / 4PX / 超级经济），
 * 让有明确类别的价卡先说话，但**任何**类别查询都能落到它身上。
 * 找不到时**返回 null**，由调用方明确报"无可用运价"，绝不静默回落到别的类别。
 */
export function pickCard(
  country: CountryRate,
  grams: number,
  opts: QuoteOptions = {}
): RateCard | null {
  const forced = opts.category && opts.category !== 'auto' ? opts.category : null;
  const order: Category[] = forced
    ? [forced, 'any']
    : grams <= SMALL_MAX_G
      ? ['general', 'special', 'bulk', 'any']
      : ['bulk', 'general', 'special', 'any'];
  const wantedVariant = typeof opts.variant === 'string' ? opts.variant : '';
  const cards = Array.isArray(country?.cards) ? country.cards : [];
  const inRange = (c: RateCard): boolean => grams >= c.minG && grams <= c.maxG;

  for (const cat of order) {
    const cands = cards.filter((c) => c.categories.includes(cat) && inRange(c));
    if (!cands.length) continue;
    if (wantedVariant) {
      const exact = cands.find((c) => c.variant === wantedVariant);
      if (exact) return exact;
      continue; // 指定了变体但该国没有 → 换下一类别，而不是拿别的仓顶替
    }
    // 无变体价卡优先（乌克兰的非普货才有 其他仓/香港仓）
    return cands.find((c) => !c.variant) ?? cands[0];
  }
  return null;
}

/** 取整到分。`ceil` 用于"报价单实际按进位结算"的场景；epsilon 抵消浮点误差 */
export function applyRounding(x: number, rounding: Rounding = 'round'): number {
  if (!Number.isFinite(x)) return 0;
  const cents = x * 100;
  const r = rounding === 'ceil' ? Math.ceil(cents - 1e-9) : Math.round(cents);
  return r / 100;
}

/**
 * 单张价卡计价。
 *
 * perKg    ：`费率 × 克重 ÷ 1000 + 挂号费`
 * firstStep：`首重 + ⌈(克重 − 首重克数) ÷ 续重步长⌉ × 续重`（不超首重只收首重）
 *
 * 克重先抬到该价卡的**最低计费重量**（报价单单列「最低计费重量 10g」/「起重 克」）：
 * 不足则按最低值计重。不套用会少算 —— 金额不大，但口径与承运商结算不一致。
 */
export function computeFee(
  card: RateCard,
  grams: number,
  rounding: Rounding = 'round'
): { fee: number; breakdown: QuoteBreakdown } {
  const g = Math.max(0, Number(grams) || 0);
  const floor = Number(card.minChargeG) > 0 ? Number(card.minChargeG) : 0;
  const chargeG = Math.max(g, floor);
  const breakdown: QuoteBreakdown = {
    delivery: 0,
    register: 0,
    first: 0,
    extra: 0,
    raw: 0,
    chargeG,
  };

  if (card.mode === 'perKg') {
    breakdown.delivery = (card.ratePerKg * chargeG) / 1000;
    breakdown.register = card.registerFee;
  } else {
    const base = card.baseG > 0 ? card.baseG : BASE_G;
    const step = card.stepG > 0 ? card.stepG : STEP_G;
    breakdown.first = card.firstFee;
    breakdown.extra = chargeG > base ? Math.ceil((chargeG - base) / step) * card.stepFee : 0;
  }

  const raw = breakdown.delivery + breakdown.register + breakdown.first + breakdown.extra;
  breakdown.raw = raw;
  return { fee: applyRounding(raw, rounding), breakdown };
}

/** 该价卡能否按本域币种计价（不能则给出原因；`''` = 可计价） */
export function quotableRefusal(card: RateCard): string {
  const currency = card.currency ?? '';
  if (currency === QUOTE_CURRENCY) return '';
  return CURRENCY_REFUSAL[currency] ?? `${currency} 报价，尚未接入汇率，未换算`;
}

function summarize(c: RateCard): CandidateSummary {
  return {
    minG: c.minG,
    maxG: c.maxG,
    categories: c.categories,
    mode: c.mode,
    variant: c.variant,
  };
}

/**
 * 对运价表内**每个国家**算一次运费（一次调用拿全量结果）。
 *
 * 为什么整表一次算而不是逐国调：宿主的 op 是无状态的，逐国调就要把运价表来回传 N 次；
 * 一次算完整表的返回量（184 行 × 十余字段）远小于运价表本身。
 * 排序：有价的在前（按运费升序），无价的在后（按中文名）。
 *
 * 无价有两种，原因文案必须分开（前者是"量不在档位里"，后者是"这条路经还没打通"）：
 *   · 该重量段无可用运价 —— 档位不覆盖；
 *   · 非本币报价 —— 见 QUOTE_CURRENCY。
 */
export function quoteAll(table: RateTable, grams: number, opts: QuoteOptions = {}): QuoteRow[] {
  const g = Number(grams);
  const list = Array.isArray(table?.countries) ? table.countries : [];
  const rounding: Rounding = opts.rounding === 'ceil' ? 'ceil' : 'round';

  const rows: QuoteRow[] = list.map((c) => {
    const card = pickCard(c, g, opts);
    if (!card) {
      return {
        code: c.code,
        nameCn: c.nameCn,
        nameEn: c.nameEn,
        ok: false,
        reason: '该重量段无可用运价',
        fee: 0,
        breakdown: null,
        category: null,
        variant: '',
        card: null,
        candidates: c.cards.map(summarize),
      };
    }
    const refusal = quotableRefusal(card);
    if (refusal) {
      return {
        code: c.code,
        nameCn: c.nameCn,
        nameEn: c.nameEn,
        ok: false,
        reason: refusal,
        fee: 0,
        breakdown: null,
        category: card.categories[0] ?? null,
        variant: card.variant,
        card,
        candidates: [],
      };
    }
    const { fee, breakdown } = computeFee(card, g, rounding);
    return {
      code: c.code,
      nameCn: c.nameCn,
      nameEn: c.nameEn,
      ok: true,
      reason: '',
      fee,
      breakdown,
      category: card.categories[0] ?? null,
      variant: card.variant,
      card,
      candidates: [],
    };
  });

  return rows.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (a.ok && b.ok && a.fee !== b.fee) return a.fee - b.fee;
    return a.nameCn.localeCompare(b.nameCn, 'zh-Hans-CN');
  });
}

/** 档位区间 → 展示文本（`≤150g` / `>2.1kg`），供 UI 复用同一口径 */
export function formatRange(minG: number, maxG: number): string {
  const fmt = (g: number): string => (g >= 1000 ? `${+(g / 1000).toFixed(3)}kg` : `${g}g`);
  if (minG <= 0) return `≤${fmt(maxG)}`;
  if (!Number.isFinite(maxG) || maxG >= BULK_MAX_G) return `>${fmt(minG)}`;
  return `${fmt(minG)}–${fmt(maxG)}`;
}
