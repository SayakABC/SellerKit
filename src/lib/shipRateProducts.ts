// src/lib/shipRateProducts.ts
// 「按产品试算」的**纯函数**半场：产品库 SKU 克重 × 选定目的国 → 逐 SKU 运费。
//
// 与既有三件的分工（同 shipRateOrders 的分层理由）：
//   shipRate.ts          报价单 Excel → 运价表
//   shipRateQuote.ts     运价表 × 克重 → 运费（单点计价口径，本文件必须复用、不得另写）
//   shipRateOrders.ts    订单侧的数据衔接（国家逐单解析 / 拒算分类）
//   本文件               产品侧的数据衔接：SKU 粒度行 × 单一目的国（国家由用户**点名**选定）
//
// 与订单侧的关键差异：
//   · 国家不是逐行提取的，而是用户在目的国下拉里**显式点名**（选项即运价表国家行）——
//     所以「表没该国」在这里是编程性错误（直接抛错），不是逐行拒算分类；
//   · 重量来自产品库 pl_variants.weight_g（SKU 子表），不是速卖通商品信息 Excel；
//     没维护克重的 SKU / 没建 SKU 的款式各自**单独成行**给出原因，不静默丢行。

import type { RateTable, Rounding } from './shipRate';
import { pickCard, quotableRefusal, computeFee, type QuoteOptions } from './shipRateQuote';
import { buildCountryIndex, resolveCountry } from './shipRateOrders';

/** 产品侧行（宿主 op 从 pl_products + pl_variants 联好后传入） */
export interface ProductQuoteInput {
  productId: number;
  /** 款编码（与订单 / 采购 / 成本同口径的关联锚点） */
  code: string;
  name: string;
  /** SKU 标签：'颜色 尺码'（成对生成）/ 旧数据 name / ''（款式没建任何 SKU） */
  skuLabel: string;
  /** 单件克重（克）；null = 该 SKU 没维护克重 */
  weightG: number | null;
}

export interface ProductQuoteRow {
  productId: number;
  code: string;
  name: string;
  skuLabel: string;
  /** 单件克重（未维护为 0） */
  weightG: number;
  /** 解析出的运价表国家信息 */
  countryCode: string;
  nameCn: string;
  ok: boolean;
  reason: string;
  /** 拒算分类（ok=true 时为 ''）。产品侧没有 noCountry（国家是点名的） */
  reasonClass: '' | 'noWeight' | 'unknownCountry' | 'noPrice' | 'refused';
  fee: number;
}

/** 批量结果的分类计数（互斥，Σ = rows.length） */
export interface ProductQuoteSummary {
  total: number;
  ok: number;
  /** 未维护克重（SKU 克重为空 / 款式没建 SKU） */
  noWeight: number;
  /** 目的国在运价表里没解析到（正常走不到：国家来自表自身的下拉） */
  unknownCountry: number;
  /** 重量段无可用运价 */
  noPrice: number;
  /** 非本币拒算 */
  refused: number;
}

/**
 * 逐 SKU 批量计价：目的国**只解析一次**（对全表行共用）。
 * 目的国解析不到时整批抛错 —— 国家来自运价表自身的下拉，选不出来表外的值；
 * 静默给每行打 unknownCountry 反而把「下拉和表不同源」这种真 bug 掩盖成普通拒算。
 */
export function quoteProducts(
  table: RateTable,
  countryRaw: string,
  items: ProductQuoteInput[],
  opts: QuoteOptions & { rounding?: Rounding } = {}
): { rows: ProductQuoteRow[]; summary: ProductQuoteSummary } {
  const index = buildCountryIndex(table);
  const c = resolveCountry(index, String(countryRaw ?? '').trim());
  if (!c) throw new Error(`运价表没有「${countryRaw}」，请重新导入运价表或换一个目的国`);

  const rounding: Rounding = opts.rounding === 'ceil' ? 'ceil' : 'round';
  const out: ProductQuoteRow[] = [];
  const summary: ProductQuoteSummary = {
    total: 0,
    ok: 0,
    noWeight: 0,
    unknownCountry: 0,
    noPrice: 0,
    refused: 0,
  };

  for (const it of Array.isArray(items) ? items : []) {
    summary.total++;
    const weightG = Number(it?.weightG);

    const fail = (
      reason: string,
      cls: Exclude<keyof ProductQuoteSummary, 'total' | 'ok'>
    ): void => {
      summary[cls]++;
      out.push({
        productId: Number(it?.productId) || 0,
        code: String(it?.code ?? ''),
        name: String(it?.name ?? ''),
        skuLabel: String(it?.skuLabel ?? ''),
        weightG: Number.isFinite(weightG) && weightG > 0 ? Math.round(weightG) : 0,
        countryCode: c.code,
        nameCn: c.nameCn,
        ok: false,
        reason,
        reasonClass: cls,
        fee: 0,
      });
    };

    if (!Number.isFinite(weightG) || weightG <= 0) {
      const sku = String(it?.skuLabel ?? '').trim();
      fail(sku ? `SKU「${sku}」未维护克重（产品库 → 编辑）` : '未维护克重（产品库 → 编辑，先建 SKU 并填克重）', 'noWeight');
      continue;
    }
    const card = pickCard(c, weightG, opts);
    if (!card) {
      fail(`该重量段无可用运价（${Math.round(weightG)}g）`, 'noPrice');
      continue;
    }
    const refusal = quotableRefusal(card);
    if (refusal) {
      fail(refusal, 'refused');
      continue;
    }
    const { fee } = computeFee(card, weightG, rounding);
    summary.ok++;
    out.push({
      productId: Number(it?.productId) || 0,
      code: String(it?.code ?? ''),
      name: String(it?.name ?? ''),
      skuLabel: String(it?.skuLabel ?? ''),
      weightG: Math.round(weightG),
        countryCode: c.code,
        nameCn: c.nameCn,
        ok: true,
      reason: '',
      reasonClass: '',
      fee,
    });
  }

  return { rows: out, summary };
}
