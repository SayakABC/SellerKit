// src/core/services/shipRateOps.ts
// 「无忧物流运费」业务域的六个 op —— **全应用唯一实现**。
//
// 来历（2026-10-15 回收为内建）：这六个 op 原本只住在 `src/core/plugin/host.ts` 的
// 岛桥 `DB_OPS['shipping-rate']` 里（iframe 岛通过 window.__sk 调）。该功能回收为
// 内建页面（「基础数据 › 物流运费」）后，页面要**直接**调同一份逻辑 ——
// 若在页面里另写一遍，就是"两份实现"：档位/取整/类别优先级任何一处漂移都会让
// 同一份报价单算出两个数（本仓反复强调的静默错价）。故抽到本文件：
//   · 宿主桥域（host.ts）改为**薄委托**（市场里已装旧岛的用户照常能用）；
//   · 内建页面（shop-accounts/shipRateStore.ts）直接 import 本文件。
//
// 解析与计价为什么都在宿主侧（岛时代的结论，内建后依然成立）：
//   ① xlsx 只有一份（core/services/importSheet 动态引入），不为任何一个入口打包第二份；
//   ② 归一化 + 计价口径单源在 @/lib/shipRate 与 @/lib/shipRateQuote / shipRateOrders /
//      shipRateProducts —— 页面只收集参数、渲染返回值，自己不做任何算术。

import { ipc } from './ipc';
import * as importSheet from './importSheet';
import { loadSkuWeights } from './skuWeights';
import { ecStr } from '../plugin/sanitizeExcel';
import type { RateTable } from '@/lib/shipRate';
import type { QuoteOptions, QuoteRow } from '@/lib/shipRateQuote';
import { quoteAll, isCategory } from '@/lib/shipRateQuote';
import type { OrderQuoteRow, OrderQuoteSummary } from '@/lib/shipRateOrders';
import { extractShipping, quoteOrders as quoteOrdersImpl } from '@/lib/shipRateOrders';
import type { ProductQuoteRow, ProductQuoteSummary } from '@/lib/shipRateProducts';
import { quoteProducts as quoteProductsImpl } from '@/lib/shipRateProducts';
import { resolveWeightG } from '@/lib/orderCost';

/** 取数类 IPC 的拆包（宿主桥时代 unwrap 的同款；成功/失败扁平形状，见 AGENTS 关于 strict:false 的说明） */
async function unwrap<T>(p: Promise<{ success: boolean; data?: T; error?: string }>): Promise<T> {
  const r = await p;
  if (!r.success) throw new Error(r.error || '操作失败');
  return r.data as T;
}

// ─────────────────────────────────────────────────────────────── 运价表（留档 + 读取）

/** 宿主快照里"当前那一份"的只读视图（岛时代 rateCurrent 的返回形状） */
export interface RateSnapshotView {
  id: number;
  effectiveFrom: string;
  sourceFile: string;
  sheetName: string;
  table: RateTable;
}

/**
 * 运价表的**唯一读口**（M6 运价表回迁，2026-09-30）：`sr_rate_snapshots` 按生效日倒序第一条。
 *
 * 为什么真源在宿主而不在任何一个界面/岛里：ADR-002 C3 要求主数据挂中立层 ——
 * 运价表存在可卸载的岛私有 storage 里时，"只留当前一份"会让历史订单的运费
 * 随报价单更新而变、不可复算；且任何跨域算运费都够不到它。
 *
 * @returns `null` = 一条快照都没有 —— 调用方按"还没有运价表"处理（**不要**静默用空表算）
 */
export async function rateCurrent(): Promise<RateSnapshotView | null> {
  const r = await ipc.shipRateSnapshotCalc({ limit: 1 });
  if (!r.success) throw new Error(r.error || '读取运价表快照失败');
  const row = (r.data?.rows ?? [])[0];
  if (!row || !row.table) return null;
  const table = row.table as RateTable;
  if (!Array.isArray(table.countries)) return null;
  return {
    id: Number(row.id) || 0,
    effectiveFrom: String(row.effectiveFrom ?? ''),
    sourceFile: String(row.sourceFile ?? ''),
    sheetName: String(row.sheetName ?? ''),
    table,
  };
}

/** 计价前的取表：没有快照就报一句人能看懂的话（界面据此渲染空态） */
export async function requireRateTable(): Promise<RateTable> {
  const snap = await rateCurrent();
  if (!snap) {
    throw new Error('还没有运价表：先在「基础数据」的「物流运费」里导入一次报价单');
  }
  return snap.table;
}

/** 一次性**迁移**口：把旧版岛私有 storage 里的运价表交给宿主快照（宿主按内容 sha256 去重，重入安全） */
export async function rateAdopt(table: unknown, source: { sourceFile?: string; sheetName?: string }): Promise<void> {
  await unwrap(
    ipc.shipRateSnapshotSave({
      table,
      sourceFile: ecStr(source?.sourceFile, 500),
      sheetName: ecStr(source?.sheetName, 200),
    }),
  );
}

// ─────────────────────────────────────────────────────────────── 报价单导入

/** parseRateSheet 的两个参数语义**必须分清**（混用会把"换了个文件"变成硬失败） */
export interface RateImportOptions {
  /** **显式点名**：用户在「切换工作表」里选了哪张读哪张；不存在直接报错，不静默改判 */
  sheetName?: string;
  /** **名称提示**：优先它，认不出来时自动落到可用的表上（换版后 sheet 改名是常态） */
  prefer?: string;
}

/**
 * 读报价单并归一化 + 宿主留档（实现单源在 `core/services/importSheet`）。
 *
 * ⚠️ 这里**不再回落到第一个 sheet**（旧写法 `want ? … : sheetNames[0]`）：
 *    报价单工作簿是 21 张 sheet 拼在一本里，第一张是「目录」；目标表在第 10 张。
 *    回落写法让"导入运价表"必失败，还把原因误报成「该 sheet 不是报价单结构」。
 */
export async function parseRateSheet(
  filePath: string,
  opts: RateImportOptions = {},
): Promise<importSheet.RateImportOutcome> {
  return importSheet.importRateSheet(
    { filePath },
    { sheetName: ecStr(opts.sheetName, 120), prefer: ecStr(opts.prefer, 120) },
  );
}

// ─────────────────────────────────────────────────────────────── 计价（三个入口共用一份口径）

/** 计价偏好（三个试算入口共用同一份配置） */
export interface QuotePrefs {
  category?: string;
  variant?: string;
  rounding?: string;
}

const normRounding = (v: unknown): 'round' | 'ceil' => (v === 'ceil' ? 'ceil' : 'round');

const normCategory = (v: unknown): QuoteOptions['category'] =>
  isCategory(v) ? v : 'auto';

/** 按克重算全表（一次调用拿全部国家的结果；界面不做任何算术）。表由**宿主自取**当前快照 */
export async function quote(
  grams: number,
  prefs: QuotePrefs = {},
): Promise<{ grams: number; results: QuoteRow[] }> {
  const table = await requireRateTable();
  const g = Number(grams);
  if (!Number.isFinite(g) || g <= 0) throw new Error('克重必须是正数');
  return {
    grams: Math.round(g),
    results: quoteAll(table, g, {
      category: normCategory(prefs.category),
      variant: ecStr(prefs.variant, 40),
      rounding: normRounding(prefs.rounding),
    }),
  };
}

/** 逐单试算：订单原始行（宿主自取，最小投影）→ 收货国家 + 款色码 → 联 SKU 克重 → 逐单计价 */
export async function quoteOrders(
  opts: { limit?: number; rounding?: string; category?: string } = {},
): Promise<{ rows: OrderQuoteRow[]; summary: OrderQuoteSummary }> {
  const table = await requireRateTable();
  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit)
      ? Math.min(Math.max(Math.round(opts.limit), 1), 2000)
      : 500;
  const r = await ipc.orderShippingRows({ limit });
  if (!r.success) throw new Error(r.error || '读取订单失败');

  const rowsFull = Array.isArray(r.data) ? r.data : [];
  const extracted = rowsFull.map((row) => ({
    id: Number(row?.id) || 0,
    orderNo: String(row?.orderNo ?? ''),
    ...extractShipping(row?.rawFields ?? {}),
  }));
  // 克重：**只从产品库 SKU 表取**（与「算钱」「发货台」同一份判定 resolveWeightG）。
  // 识别不出款色码的行如实报「缺重量」，不拿别的款顶上。
  const skuWeights = await loadSkuWeights();
  const input = rowsFull.map((row, i) => {
    const ex = extracted[i];
    return {
      id: ex.id,
      orderNo: ex.orderNo,
      country: ex.country,
      itemId: ex.itemId,
      weightG: resolveWeightG(
        {
          styleCode: (row as { styleCode?: unknown })?.styleCode,
          color: (row as { color?: unknown })?.color,
          size: (row as { size?: unknown })?.size,
        },
        skuWeights,
      ),
    };
  });
  return quoteOrdersImpl(table, input, {
    category: normCategory(opts.category),
    rounding: normRounding(opts.rounding),
  });
}

/** 按产品试算：产品库（pl_products + pl_variants 克重）× 点名目的国 → 逐 SKU 运费 */
export async function quoteProducts(
  country: string,
  opts: { limit?: number; search?: string; rounding?: string; category?: string } = {},
): Promise<{ rows: ProductQuoteRow[]; summary: ProductQuoteSummary }> {
  const table = await requireRateTable();
  const c = ecStr(country, 80);
  if (!c) throw new Error('请指定目的国家/地区');
  const search = ecStr(opts.search, 200);
  const cap =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit)
      ? Math.min(Math.max(Math.round(opts.limit), 1), 2000)
      : 1000;

  // 产品分页拉全（listProducts 单页上限 500；productIds 进 variantList 前还要再分批）
  const products: Array<{ id: number; code: string; name: string }> = [];
  for (let offset = 0; offset < cap; offset += 500) {
    const r = await ipc.productList({ search, status: '', offset, limit: Math.min(500, cap - offset) });
    if (!r.success) throw new Error(r.error || '读取产品库失败');
    const batch = r.data?.rows ?? [];
    for (const it of batch) {
      products.push({ id: Number(it?.id) || 0, code: String(it?.code ?? ''), name: String(it?.name ?? '') });
    }
    if (batch.length < 500 || products.length >= (r.data?.total ?? 0)) break;
  }

  // SKU 分批拉全（IN 列表 500 一批，与 orderShippingRows 的 id 切片同口径）
  const variants: Array<{ productId: number; color: string; size: string; name: string; weightG: number }> = [];
  for (let i = 0; i < products.length; i += 500) {
    const v = await ipc.productVariantList({ productIds: products.slice(i, i + 500).map((x) => x.id) });
    if (!v.success) throw new Error(v.error || '读取 SKU 失败');
    for (const it of v.data?.rows ?? []) {
      variants.push({
        productId: Number(it?.productId) || 0,
        color: String(it?.color ?? ''),
        size: String(it?.size ?? ''),
        name: String(it?.name ?? ''),
        weightG: Number(it?.weightG) || 0,
      });
    }
  }

  // 组装计价行：有 SKU 的按 SKU 展开（SKU 标签 = '颜色 尺码'，老数据回落 name）；
  // 没建 SKU 的款式单独成行（skuLabel 空串 = 纯款式行），重量置 null 让纯函数报「未维护克重」。
  const byProduct = new Map<number, typeof variants>();
  for (const v of variants) {
    const list = byProduct.get(v.productId) ?? [];
    list.push(v);
    byProduct.set(v.productId, list);
  }
  const items = products.flatMap((pr) => {
    const vs = byProduct.get(pr.id) ?? [];
    if (!vs.length) return [{ productId: pr.id, code: pr.code, name: pr.name, skuLabel: '', weightG: null }];
    return vs.map((v) => ({
      productId: pr.id,
      code: pr.code,
      name: pr.name,
      skuLabel: [v.color, v.size].filter(Boolean).join(' ') || v.name,
      weightG: v.weightG > 0 ? v.weightG : null,
    }));
  });

  return quoteProductsImpl(table, c, items, {
    category: normCategory(opts.category),
    rounding: normRounding(opts.rounding),
  });
}
