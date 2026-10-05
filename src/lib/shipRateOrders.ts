// src/lib/shipRateOrders.ts
// 「按订单算运费」的**纯函数**半场：订单原始字段 → (克重, 目的地) → 逐单运费。
//
// 与既有两件的分工：
//   shipRate.ts        报价单 Excel → 运价表
//   shipRateQuote.ts   运价表 × 克重 → 运费（单点计价口径，本文件必须复用、不得另写）
//   本文件             订单侧的数据衔接：国家解析 / 字段提取 / 逐单批量计价
//
// 数据现状（SHIPPING_RATE_ISLAND_PLAN §8）：
//   · 目的地在 oi_orders.raw_fields 的「收货国家」（速卖通导出为英文名），
//     而运价表的国家行自带 中文名/英文名/ISO code —— 所以**映射可以直接对运价表做**，
//     不需要单独维护一张国名表；别名只补「同一国家的不同拼写」（USA/UK/Viet Nam…）。
//   · 克重来自「商品信息」导入的 pl_item_weights（商品ID → 克），由宿主 op 联好再进来；
//     本文件不管重量缺失的补救，只负责**明确拒算并给出原因**。

import type { CountryRate, RateTable, Rounding } from './shipRate';
import { pickCard, quotableRefusal, computeFee, type QuoteOptions } from './shipRateQuote';

/** 订单侧原始行（宿主 op 从 oi_orders.raw_fields 提取后传入） */
export interface OrderShippingRow {
  id: number;
  orderNo: string;
  /** raw_fields 里的收货国家原文（可能为空） */
  country: string;
  /** raw_fields 里的商品ID（可能为空） */
  itemId: string;
  /** pl_item_weights 查到的单件克重；null = 该商品ID没导入重量 */
  weightG: number | null;
}

export interface OrderQuoteRow {
  id: number;
  orderNo: string;
  /** 解析出的运价表国家信息；未命中时 code 为空串 */
  code: string;
  nameCn: string;
  countryRaw: string;
  itemId: string;
  /** 单件克重（未导入重量为 0） */
  weightG: number;
  ok: boolean;
  reason: string;
  /** 拒算分类（与 OrderQuoteSummary 的键同口径；ok=true 时为 ''）。岛按它着色/分桶 */
  reasonClass: '' | 'noWeight' | 'noCountry' | 'unknownCountry' | 'noPrice' | 'refused';
  fee: number;
}

/** 批量结果的分类计数（界面摘要用；互斥，Σ = rows.length） */
export interface OrderQuoteSummary {
  total: number;
  ok: number;
  /** 未导入重量（商品信息没这份商品ID） */
  noWeight: number;
  /** 订单没有收货国家 */
  noCountry: number;
  /** 有国家但运价表不覆盖 */
  unknownCountry: number;
  /** 重量段无可用运价 */
  noPrice: number;
  /** 非本币拒算 */
  refused: number;
}

// ─────────────────────────────────────────────────────────── 国家名归一化

/** 全角 → 半角 + 去空白与标点 + 小写。国名匹配只在归一化形态上进行 */
function normCountry(s: string): string {
  return (s || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\s.·,，、'"()（）\-–—]/g, '');
}

/**
 * 高频拼写差异别名（键 = 归一化后的订单侧写法，值 = 运价表 nameEn 的归一化形态）。
 *
 * ⚠️ 值必须以**运价表实际写法**为准（源表：Korea / Russian Federation / United States），
 * 加别名前先查表，宁缺毋滥 —— 错误别名会把 A 国的订单算成 B 国的运费且无任何告警。
 */
const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'unitedstates',
  us: 'unitedstates',
  ukingdom: 'unitedkingdom',
  uk: 'unitedkingdom',
  greatbritain: 'unitedkingdom',
  southkorea: 'korea', // 速卖通写 South Korea，报价单写 Korea
  russia: 'russianfederation', // 报价单写全称
};

/** 在运价表里建一次查找索引（逐单解析时复用，184 国 × 千单不至于 O(n²)） */
export function buildCountryIndex(table: RateTable): Map<string, CountryRate> {
  const idx = new Map<string, CountryRate>();
  const list = Array.isArray(table?.countries) ? table.countries : [];
  for (const c of list) {
    for (const key of [c.code, c.nameEn, c.nameCn]) {
      const k = normCountry(key);
      if (k && !idx.has(k)) idx.set(k, c);
    }
  }
  return idx;
}

/**
 * 订单侧国家原文 → 运价表国家行。
 *
 * 匹配顺序：精确 ISO/英文名/中文名 → 别名表 → 前缀包含（「美国(西半球)」这类带注记的写法）。
 * 前缀包含只在原文长度 ≥4 时启用且要求命中 ≥3 字符，避免两字国名误吞（如「乍得」⊂「乍得?」之外几乎安全）。
 */
export function resolveCountry(index: Map<string, CountryRate>, raw: string): CountryRate | null {
  const n = normCountry(raw);
  if (!n) return null;
  const hit = index.get(n);
  if (hit) return hit;
  const alias = COUNTRY_ALIASES[n];
  if (alias) return index.get(alias) ?? null;
  if (raw.trim().length >= 4) {
    for (const [k, c] of index) {
      if (k.length >= 3 && (k.includes(n) || n.includes(k))) return c;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────── 字段提取

/** 收货国家列名族：从具体到宽泛逐个试（「国家」可能撞上别的列，所以放最后） */
const COUNTRY_KEYS = [/^收货国家$/, /收货.*国家/, /^国家$/, /国家|地区/, /^country$/i];
/** 商品ID 列名族：与 orderRowSplitter 的探测同口径 */
const ITEM_ID_KEYS = [/商品\s*ID/i, /产品\s*ID/i, /SKU/i, /货号/];

function pickKey(rawFields: Record<string, string>, patterns: RegExp[]): string {
  for (const re of patterns) {
    for (const k of Object.keys(rawFields ?? {})) {
      if (re.test(k) && String(rawFields[k] ?? '').trim()) return k;
    }
  }
  return '';
}

/**
 * 从一条订单的 raw_fields 里提取运费所需字段。
 *
 * ⚠️ 数量刻意**恒取 1**：多产品订单拆行后每行仍带着原始「数量」列值（splitter 不清空），
 * 用它会把 3 件拆出的每行都按 3 件算（3×3）。数量 >1 的合并计费留待 UI 明确选择后再做
 * （PLAN §8 已记为开放项），宁可少报也不静默多算。
 */
export function extractShipping(rawFields: Record<string, string>): {
  country: string;
  itemId: string;
} {
  const ck = pickKey(rawFields, COUNTRY_KEYS);
  const ik = pickKey(rawFields, ITEM_ID_KEYS);
  return {
    country: ck ? String(rawFields[ck]).trim() : '',
    itemId: ik ? String(rawFields[ik]).trim() : '',
  };
}

// ─────────────────────────────────────────────────────────── 逐单计价

export function quoteOrders(
  table: RateTable,
  rows: OrderShippingRow[],
  opts: QuoteOptions & { rounding?: Rounding } = {}
): { rows: OrderQuoteRow[]; summary: OrderQuoteSummary } {
  const index = buildCountryIndex(table);
  const rounding: Rounding = opts.rounding === 'ceil' ? 'ceil' : 'round';
  const out: OrderQuoteRow[] = [];
  const summary: OrderQuoteSummary = {
    total: 0,
    ok: 0,
    noWeight: 0,
    noCountry: 0,
    unknownCountry: 0,
    noPrice: 0,
    refused: 0,
  };

  for (const r of Array.isArray(rows) ? rows : []) {
    summary.total++;
    const countryRaw = String(r?.country ?? '').trim();
    const itemId = String(r?.itemId ?? '').trim();
    const weightG = Number(r?.weightG);

    const fail = (
      reason: string,
      cls: Exclude<keyof OrderQuoteSummary, 'total' | 'ok'>,
      code = '',
      nameCn = ''
    ): void => {
      summary[cls]++;
      out.push({
        id: Number(r?.id) || 0,
        orderNo: String(r?.orderNo ?? ''),
        code,
        nameCn,
        countryRaw,
        itemId,
        weightG: Number.isFinite(weightG) && weightG > 0 ? Math.round(weightG) : 0,
        ok: false,
        reason,
        reasonClass: cls,
        fee: 0,
      });
    };

    if (!itemId || !Number.isFinite(weightG) || weightG <= 0) {
      fail(
        itemId ? `商品 ${itemId} 未导入重量（商品信息表没有该ID）` : '订单未标注商品ID，无法取重量',
        'noWeight'
      );
      continue;
    }
    if (!countryRaw) {
      fail('订单未标注收货国家', 'noCountry');
      continue;
    }
    const c = resolveCountry(index, countryRaw);
    if (!c) {
      fail(`运价表没有「${countryRaw}」`, 'unknownCountry');
      continue;
    }
    const card = pickCard(c, weightG, opts);
    if (!card) {
      fail(`该重量段无可用运价（${weightG}g）`, 'noPrice', c.code, c.nameCn);
      continue;
    }
    const refusal = quotableRefusal(card);
    if (refusal) {
      fail(refusal, 'refused', c.code, c.nameCn);
      continue;
    }
    const { fee } = computeFee(card, weightG, rounding);
    summary.ok++;
    out.push({
      id: Number(r?.id) || 0,
      orderNo: String(r?.orderNo ?? ''),
      code: c.code,
      nameCn: c.nameCn,
      countryRaw,
      itemId,
      weightG: Math.round(weightG),
      ok: true,
      reason: '',
      reasonClass: '',
      fee,
    });
  }

  return { rows: out, summary };
}
