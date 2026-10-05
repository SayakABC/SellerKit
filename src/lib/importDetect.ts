// src/lib/importDetect.ts
// 「这份 Excel 是什么」的**纯检测层**（零副作用、可 vitest）—— 统一导入入口的判据只有这一份。
//
// 为什么要它：以前每类文件各有一个"导入入口"（订单报表在订单归类岛、商品信息在运费岛、结算明细在算钱页），
// 用户得先知道"该去哪个功能选文件"。现在反过来：**用户只管拖文件，软件判断类型并落到对的表**。
//
// 判据一律**复用各解析器自己的入口条件**（不另立一套）：
//   · 结算明细 = `pickSettleSheet`（商品id + 结算状态）；
//   · 报价单   = `normalizeRateSheet` + `pickRateSheet`（归一后真有国家与价卡）；
//   · 订单报表 = 表头签名（订单号 + 订单金额/商品信息）—— 这条没有独立解析器（导入在岛里），故用签名字面量。
//
// ⚠️ **「商品信息」不再是可导入的类型**（2026-10-01，用户领域裁定）：克重是 SKU 属性，
//    商品ID 上没有克重 ⇒ 原来那条 `parseWeightSheet → pl_item_weights` 的链整条删除。
//    克重改在「货与成本」按 SKU 维护（`pl_variants.weight_g`）。用户真拿这种表来导时，
//    下面的 `looksLikeItemInfoSheet` 会给一句**指路**（而不是干说"认不出"）。
//
// **判定顺序：从具体到宽泛**（结算 → 订单 → 报价单），且**必须回报"凭什么这么判"**：
// 判错会把整份文件导进错的表，而用户看到的只是"导完了、数字不对"。回报证据串，界面直接显示。

import { normalizeRateSheet, pickRateSheet, DEFAULT_SHEET_HINT } from './shipRate';
import { pickSettleSheet } from './settleImport';

/** 统一导入入口能识别的文件类型 */
export type ImportKind = 'settle' | 'orders' | 'rates';

/** 一个工作表的原始网格（第一行是表头） */
export interface SheetGrid {
  name: string;
  /** 逐行数组（`sheet_to_json(header:1)` 的产物） */
  grid: unknown[][];
}

export interface ImportDetection {
  kind: ImportKind;
  /** 命中的工作表名 */
  sheetName: string;
  /** **凭什么这么判**（界面直接显示给用户；判错时这句话就是排查线索） */
  why: string;
  /**
   * 这类文件更具体的**人话名**（界面标题直接用；空/缺省 = 用 `kind` 的通用名）。
   * 为什么要有它：「订单报表」是一大类，芒果店长待发货订单是其中带店铺+主图列的子类 ——
   * 判据（`why`）本来就写得出来，但**标题**要让用户一眼认出"这正是我导的那份文件"。
   */
  variant?: string;
  /** 逐表体检的过程记录（都没命中时用来解释"我看过哪些、各自为什么不构成"） */
  scanned: string[];
}

function headerOf(grid: unknown[][]): string[] {
  return (grid?.[0] ?? []).map((h) => String(h ?? '').trim());
}

/** 网格 → 逐行对象（键＝表头原文；与既有解析器吃同一种形状） */
export function gridToRecords(grid: unknown[][]): Record<string, string>[] {
  const header = headerOf(grid);
  return (grid ?? [])
    .slice(1)
    .map((r) => Object.fromEntries(header.map((k, i) => [k, String(r?.[i] ?? '')])));
}

/**
 * 「商品信息」表头签名（商品ID + 重量）—— **只用于给一句指路**，不再当作可导入类型。
 * 判据与已删的 `parseWeightSheet` 同族（商品ID/SKU 列 + 重量列），保留在检测层里只为"认出来说人话"。
 */
function looksLikeItemInfoSheet(header: string[]): boolean {
  const has = (re: RegExp): boolean => header.some((h) => re.test(h));
  return has(/商品\s*ID|产品\s*ID|商品ID|产品ID|SKU|货号/i) && has(/物流重量|重量|weight/i);
}

/** 「订单报表」表头签名：订单号 + （订单金额 或 商品信息） */
function looksLikeOrderReport(header: string[]): boolean {
  const has = (re: RegExp): boolean => header.some((h) => re.test(h));
  return has(/订单号/) && (has(/订单金额|买家实付|产品总金额/) || has(/商品信息|产品信息/));
}

/**
 * 「芒果店长 · 待发货订单」表头签名：订单号 + 产品数量 + 产品图片链接。
 *
 * 它是订单报表的**一个更具体的子类**（上面那条签名也会命中它），单列出来只为把判据说准：
 * 与速卖通导出的区别是它**自带店铺名与主图列**（AE 按店铺导出、既没有店铺列也没有图列），
 * 于是导入侧能直接落店铺（不必再「归到该店」）、并按链接把主图下载进来（见 `importSheet.importOrders`）。
 */
function looksLikeMangoPendingSheet(header: string[]): boolean {
  const has = (re: RegExp): boolean => header.some((h) => re.test(h));
  return has(/订单号/) && has(/产品\s*数量/) && has(/产品\s*图片链接|图片链接|主图链接/);
}

/**
 * 判定一份工作簿里**有哪类数据**。
 *
 * @param sheets 各表（**保持原顺序**：同名信号时先出现的先判）
 * @returns 命中的类型 + 表名 + 判据；一个都没命中返回 `kind: null`
 */
export function detectImportKind(
  sheets: readonly SheetGrid[] | null | undefined,
): (ImportDetection & { kind: ImportKind }) | { kind: null; scanned: string[]; variant?: string } {
  const list = Array.isArray(sheets) ? sheets : [];
  const scanned: string[] = [];
  const tried = new Set<string>();

  // ① 结算明细（AE 后台「订单明细」导出）：复用它的选表判据（商品id + 结算状态）
  const settled = pickSettleSheet(
    list.map((s) => ({ name: s.name, rows: gridToRecords(s.grid) })),
  );
  if (settled) {
    tried.add(settled.name);
    return {
      kind: 'settle',
      sheetName: settled.name,
      why: '含「商品id + 结算状态」两列（AE 后台订单明细导出的签名）',
      scanned,
    };
  }

  // ② 订单报表（47 列报表）：表头签名
  for (const s of list) {
    if (tried.has(s.name)) continue;
    const header = headerOf(s.grid);
    if (looksLikeOrderReport(header)) {
      const mango = looksLikeMangoPendingSheet(header);
      return {
        kind: 'orders',
        sheetName: s.name,
        why: mango
          ? '表头含「订单号 + 产品数量 + 产品图片链接」（芒果店长待发货订单签名：自带店铺名与主图列）'
          : '表头含「订单号」且含「订单金额 / 商品信息」（订单报表签名）',
        // 标题点名到子类：用户导的是芒果店长待发货订单，回执就该叫这个名字（而不是笼统的「订单报表」）
        variant: mango ? '芒果店长待发货订单' : '',
        scanned,
      };
    }
  }

  // ③ 报价单：归一后真有国家与价卡才算（`normalizeRateSheet` 很宽容，必须再体检）
  const rateScans = list.map((s) => ({ sheetName: s.name, table: normalizeRateSheet(s.grid, s.name) }));
  // 逐表记一句"看过了、为什么不构成"—— 都没命中时界面直接显示这串，用户才知道"软件看过哪些表"
  // （曾把逐表理由写在一个聚合句里，排查时根本不知道它到底翻过哪几张 sheet）
  for (const s of rateScans) {
    scanned.push(`${s.sheetName}:不构成运价表（${s.table?.countries?.length ?? 0} 个国家）`);
  }
  const pick = pickRateSheet(rateScans, DEFAULT_SHEET_HINT);
  const chosen = rateScans.find((s) => s.sheetName === pick.sheetName && s.table && s.table.countries.length);
  if (chosen && chosen.table) {
    return {
      kind: 'rates',
      sheetName: chosen.sheetName,
      why: `归一后是国家×价卡的运价表（${chosen.table.countries.length} 个国家）`,
      scanned,
    };
  }
  scanned.push('所有工作表都不构成运价表（没有国家与价卡）');

  // 全部落空：如果看起来是「商品信息」表，给一句**人话指路**（它不再是可导入类型，克重在「货与成本」按 SKU 维护）
  for (const s of list) {
    if (looksLikeItemInfoSheet(headerOf(s.grid))) {
      return {
        kind: null,
        // 让导入回执能给出「下一步 → 货与成本」（认出的子类不同，下一步也不同）
        variant: 'item-info',
        scanned: [
          ...scanned,
          `${s.name}:看起来是「商品信息」表 —— 这类文件不用再导入：克重属于 SKU（一款不同颜色/尺码可能不同），请在「货与成本」里按 SKU 维护`,
        ],
      };
    }
  }

  return { kind: null, scanned };
}