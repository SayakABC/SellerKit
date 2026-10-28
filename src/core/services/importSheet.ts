// src/core/services/importSheet.ts
// **统一导入**：一份 Excel 进来 → 判断是什么 → 落到对的表。（重构 S2 的核心）
//
// 为什么放在 core/services：它是**数据摄取能力**（解析 + 落库路由），跟 `excel.ts`（解析 Excel）同一层；
// 业务口径一律留给 `src/lib/*` 的纯函数。**实现只有这一份** —— 宿主插件 op（`DB_OPS['shipping-rate']`
// 的 `parseRateSheet`）与内建页面都调它，避免同一件事两套实现漂移。
//
// 四类可自动落库（各自复用既有解析器与通道，**零新表零新通道**）：
//   · 结算明细 → `ae_settle_lines`（算钱页的"精准轨"数据源）
//   · 报价单   → 宿主运价表快照（算账按生效日取"当时那份"）
//   · 订单报表 → 订单主干 `oi_orders`（多产品拆行；报表自带店铺名/主图链接时一并落店铺、下主图）
//   · 「商品信息」表**不再是可导入类型**（克重是 SKU 属性，改在「基础数据 › 货品档案」按 SKU 维护）
// 订单报表的**识别队列**（AI 款式识别、缺图补链接）仍在「订单归类」岛 —— 那是"识别"不是"导入"，
// 本服务只负责把订单**落对表**（需要 AI 归类时由用户另装岛，入口在两处都已指路）。

import * as ipc from './ipc';
import { detectImportKind, type ImportKind, type SheetGrid } from '@/lib/importDetect';
import { parseSettleRows, pickSettleSheet } from '@/lib/settleImport';
import { DEFAULT_SHEET_HINT, normalizeRateSheet, pickRateSheet } from '@/lib/shipRate';
import { detectMultiProductColumns, expandOrderRows } from '@/lib/orderRowSplitter';
import { detectImageColumnStrict, detectShopColumn, detectSizeColumn } from '@/lib/orderClassifier';
import { orderRowFields } from '@/lib/orderImportRow';

/** 直接给的字节（对话框选来的）或让宿主按路径读（岛侧传路径） */
export interface ImportSource {
  data?: ArrayBuffer;
  filePath?: string;
}

export interface WorkbookSheets {
  sheetNames: string[];
  grids: SheetGrid[];
}

/** 读工作簿 → 各表的原始网格（唯一读入口；体积上限由 `importExcelByPath` 那侧把关） */
export async function readWorkbookSheets(src: ImportSource): Promise<WorkbookSheets> {
  const buf = await resolveBuffer(src);
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetNames: string[] = wb.SheetNames ?? [];
  if (!sheetNames.length) throw new Error('Excel 内没有工作表');
  return {
    sheetNames,
    grids: sheetNames.map((name) => ({
      name,
      grid: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) as unknown[][],
    })),
  };
}

async function resolveBuffer(src: ImportSource): Promise<ArrayBuffer> {
  if (src?.data instanceof ArrayBuffer) return src.data;
  const path = String(src?.filePath ?? '');
  if (!path) throw new Error('没有文件可读（既没有字节也没有路径）');
  const r = await ipc.importExcelByPath(path);
  if (!r.success || !r.data) throw new Error(r.error || '读取 Excel 失败');
  return r.data.data;
}

// ─────────────────────────────────────────────────────────── 三类落库

export interface SettleImportOutcome {
  created: number;
  updated: number;
  failed: { orderNo: string; message: string }[];
  /** 解析层的校验告警条数（平台口径可能变了） */
  issues: number;
  sheetName: string;
  parsedRows: number;
}

/** 结算明细（AE 后台「订单明细」导出）→ `ae_settle_lines` */
export async function importSettle(src: ImportSource): Promise<SettleImportOutcome> {
  const { grids } = await readWorkbookSheets(src);
  const picked = pickSettleSheet(grids.map((g) => ({ name: g.name, rows: gridToRecords(g.grid) })));
  if (!picked) {
    throw new Error('这个文件里没有「结算明细」表（需要含 商品id + 结算状态 列的那张）');
  }
  const parsed = parseSettleRows(picked.rows);
  if (!parsed.rows.length) throw new Error('没有解析出任何结算行');
  const up = await ipc.settleImport({ rows: parsed.rows });
  if (!up.success) throw new Error(up.error || '落库失败');
  const { created, updated, failed } = up.data ?? { created: 0, updated: 0, failed: [] };
  return {
    created,
    updated,
    failed,
    issues: parsed.issues.length,
    sheetName: picked.name,
    parsedRows: parsed.rows.length,
  };
}

export interface OrdersImportOutcome {
  sheetName: string;
  /** 报表原始行数 */
  rawRows: number;
  /** 多产品被拆行的订单数 */
  expanded: number;
  /** 被受理并落库的订单行数（**含幂等命中**：重复导入同一条不新增行，但仍计入） */
  inserted: number;
  /** 落库失败/跳过的行数（缺订单号等） */
  skipped: number;
  /** 成功挂到订单行上的主图张数（含复用既有图） */
  images: number;
  /** 有主图链接但下载失败的行数（这些行按**无图**落库，不丢行） */
  imageFailed: number;
  /** 报表带店铺列时落库的店铺名（去重；空数组 = 报表没有店铺列，需人工「归到该店」） */
  shops: string[];
}

/**
 * 订单报表 → 主干（`oi_orders`）。
 *
 * **带图**：报表自带「主图/图片链接」列时（芒果店长待发货订单即为这种），逐行下载主图落
 * `oi_images` 并挂到订单行 —— 拣货/算钱要图，免图导入只能靠「商品ID 图池」，而那份池子
 * 的订单层同样要求 `image_id` 非空，等于自证循环。下载失败**不丢行**：回落免图并计数上报。
 *
 * **店铺**：报表带「店铺名」列时直接落 `oi_orders.shop`（芒果店长导出自带）；
 * 没有该列（AE 按店铺导出）时留空，由「算钱」页的「归到该店」一次归好。
 *
 * 拆行与岛共用 `orderRowSplitter`（列探测也共用 `orderClassifier`）—— 两处各写一套必然漂移。
 */
export async function importOrders(src: ImportSource): Promise<OrdersImportOutcome> {
  const { grids } = await readWorkbookSheets(src);
  const det = detectImportKind(grids);
  if (det.kind !== 'orders') {
    throw new Error('这个文件不像订单报表（缺少「订单号 + 订单金额/商品信息」这类签名列）');
  }
  const sheet = grids.find((g) => g.name === det.sheetName) ?? grids[0];
  const header = (sheet.grid[0] ?? []).map((h) => String(h ?? '').trim());
  const rows = sheet.grid.slice(1).map((r) => Object.fromEntries(header.map((k, i) => [k, String(r?.[i] ?? '')])));

  // 列探测复用 `orderClassifier` 的**同一份关键词族**（别再各写一套）。
  // ⚠️ 主图列必须用 **strict** 版：无图列的报表（速卖通 47 列）回落到"第一列"会被当成图列，
  //    拆出来的行图片全空并逐行误标缺图（凭空制造待补图）。
  const shopColumn = detectShopColumn(header);
  const imageColumn = detectImageColumnStrict(header);
  const sizeColumn = detectSizeColumn(header);
  // 多产品行拆分：与岛同一份实现（两处各写一套就会"同一份报表两个行数"）
  const cols = detectMultiProductColumns(header, rows, { imageColumn, sizeColumn });
  const expanded = expandOrderRows(rows, cols);

  let inserted = 0;
  let skipped = 0;
  let images = 0;
  let imageFailed = 0;
  const shops = new Set<string>();
  for (const row of expanded.rows) {
    const f = orderRowFields(row, { shop: shopColumn, image: imageColumn });
    if (!f.orderNo) {
      skipped += 1;
      continue;
    }
    if (f.shop) shops.add(f.shop);
    // 主图：先落 `oi_images`（URL/内容指纹命中即复用），再把 id 挂到订单行
    let imageId: number | null = null;
    if (f.imageUrl) {
      try {
        const img = await ipc.orderDownloadImage(f.imageUrl);
        if (img.success && img.data?.id) {
          imageId = img.data.id;
          images += 1;
        } else {
          imageFailed += 1;
        }
      } catch {
        imageFailed += 1;
      }
    }
    try {
      const r = await ipc.orderInsert({
        imageId,
        orderNo: f.orderNo,
        shop: f.shop,
        size: f.size,
        orderTime: f.orderTime,
        category: '',
        color: '',
        logo: '',
        rawFields: row,
      });
      if (!r.success) throw new Error(r.error || '落库失败');
      inserted += 1;
    } catch {
      skipped += 1;
    }
  }
  return {
    sheetName: sheet.name,
    rawRows: rows.length,
    expanded: expanded.expanded,
    inserted,
    skipped,
    images,
    imageFailed,
    shops: [...shops],
  };
}

export interface RateImportOutcome {
  sheetNames: string[];
  sheetName: string;
  picked: 'explicit' | 'auto' | 'none';
  table: unknown;
  candidates: unknown[];
  /** 宿主快照 id（留档成功时）；0 = 没挑中表、未留档 */
  snapshotId: number;
}

/**
 * 报价单 → 归一化运价表 + **宿主留档**（按生效日取"当时那份"）。
 *
 * 快照失败**不吞**：留档失败会让后续预测悄悄用旧表（最怕的静默错），故直接抛错让用户重试
 * （导入是幂等的，重试无副作用）。点名（`sheetName`）严格按点名解析，不替用户改判到别的表。
 */
export async function importRateSheet(
  src: ImportSource,
  opts: { sheetName?: string; prefer?: string } = {},
): Promise<RateImportOutcome> {
  const { sheetNames, grids } = await readWorkbookSheets(src);
  const rowsOf = (name: string): unknown[][] => grids.find((g) => g.name === name)?.grid ?? [];

  const snapshot = async (table: unknown, sheetName: string): Promise<number> => {
    if (!table) return 0;
    const r = await ipc.shipRateSnapshotSave({
      table,
      sourceFile: String(src?.filePath ?? ''),
      sheetName,
    });
    if (!r.success) {
      throw new Error(`运价表留档失败：${r.error || '未知错误'}（本次导入未生效，可重试）`);
    }
    return r.data?.id ?? 0;
  };

  const want = String(opts?.sheetName ?? '').trim();
  if (want) {
    if (!sheetNames.includes(want)) {
      throw new Error(`Excel 内没有「${want}」工作表：${sheetNames.join(' / ')}`);
    }
    const table = normalizeRateSheet(rowsOf(want), want);
    return {
      sheetNames,
      sheetName: want,
      picked: 'explicit',
      table,
      candidates: [],
      snapshotId: await snapshot(table, want),
    };
  }

  const scans = grids.map((g) => ({ sheetName: g.name, table: normalizeRateSheet(g.grid, g.name) }));
  const pick = pickRateSheet(scans, String(opts?.prefer ?? '') || DEFAULT_SHEET_HINT);
  const chosen = scans.find((s) => s.sheetName === pick.sheetName);
  return {
    sheetNames,
    sheetName: pick.sheetName,
    picked: chosen ? 'auto' : 'none',
    table: chosen ? chosen.table : null,
    candidates: pick.candidates,
    snapshotId: chosen ? await snapshot(chosen.table, pick.sheetName) : 0,
  };
}

// ─────────────────────────────────────────────────────────── 统一入口：识别 → 落库

/**
 * 「这份文件**存到哪了**、在哪儿能看到它」—— 导入回执里必须回答的一句。
 *
 * 为什么单拎出来：用户导完最常问的不是"导了多少行"，而是**"然后呢、我刚导的东西在哪"**。
 * 三处细节都刻意：
 *   · 只给**人话名**（「订单」「结算明细」），不给物理表名（`oi_orders` 这类是开发者视角，用户可见处不该出现）；
 *   · `views` 每一项都是**用户真的能点到的页面名**，与 `tests/uxEntryNames.spec.ts` 的入口名守卫同口径（写错会红）；
 *     不写「本页」前缀 —— 回执卡渲染时统一补一个（落点目前全在「发货台」页内）；
 *   · 落点是**能力域**级（订单/结算/报价），不是"这张 sheet 的第 N 行" —— 后者用户没法用。
 */
export interface ImportLanding {
  /** 人话名（「订单」「结算明细」「运价表」） */
  label: string;
  /** 在哪些地方能看到它（界面按「、」连成一句） */
  views: string[];
}

/** 「接下来做什么」—— 导入后真正该点的那一两步（在界面上就是按钮，点了切到对应模块） */
export interface ImportNextStep {
  label: string;
  /**
   * 目标模块 id —— **必须是 `modules.config.json` 里 enabledModules 的成员**（写错 = 按钮点了没反应）。
   * 与 `tab` **二选一**：目标在「发货台」页里就写 `tab`，真跳别的模块（如 `shop-accounts`）才写它。
   */
  moduleId?: string;
  /**
   * 目标模块里的**哪一屏**（该模块自己消费的 `action`，如 `shop-accounts` 的 `goods` ⇒ 货品档案）。
   * 2026-10-17 新增：目标不再是"一个模块 = 一个页面"之后（基础数据有七类资料），
   * 只说模块 id 会把人丢在该模块**上次停留的那一类**上 —— 用户点了「维护 SKU 克重」却落在"店铺账号"，
   * 这就是"点了没反应"的另一种形态。
   */
  action?: string;
  /**
   * 目标是「发货台」页里的哪个页签（`flowCtx.SHIPPING_TAB_NAMES` 的**键**：`classify` / `purchase` / `recon`）。
   * 有它就**就地切页签**（与流程卡、总览卡的"下一步"同一套机制），不跳模块、不丢当前页面。
   * ⚠️ 值必须是那里真有的键：写错 = 按钮点了没反应，而界面上看不出任何异常。
   * ⚠️ 2026-10-17：算钱页签已撤（归拢到独立「统计」= `order-cost`）⇒ 与钱有关的三处改用 `moduleId`。
   */
  tab?: string;
  /** 主操作（一条回执最多一个；界面渲成 primary 按钮） */
  primary?: boolean;
}

export interface AutoImportResult {
  /** 识别到的类型；`null` = 没认出（此时 `scanned` 是逐表体检结论） */
  kind: ImportKind | null;
  sheetName: string;
  why: string;
  scanned: string[];
  /** 真的写了库吗（false = 只给指引，没动数据） */
  wrote: boolean;
  /**
   * **大字结论**：这次到底发生了什么（一行，界面按最大字号渲染）。
   *
   * 为什么与原 `message` 分开（2026-10-11 用户实报"反馈信息模糊、文字太多、完全看不懂"）：
   * 原来那一整句把**结论**（导了多少行）与**判据**（识别凭什么、拆了几行、主图成没成）
   * 揉在一起，用户得读完才知道结果。现在拆成两层 —— 结论在这里（大字），判据在 `message`
   * （折叠在「怎么看出来的」里，出问题时才展开）。
   */
  headline: string;
  /** 排查用的**判据**（识别凭什么这么判、导了多少行…）—— 回执卡里**默认折叠**，别往这里放结论 */
  message: string;
  /** 识别到的人话类型名（回执卡标题；空 = 用 `kind` 的通用名） */
  title: string;
  /** 落到哪去了；`null` = 没写库（没有落点可讲，界面只说"没动数据"） */
  landed: ImportLanding | null;
  /**
   * **异常行**：需要用户知道、但**没到报错那一步**的事（跳过几行 / 主图没下下来 / 校验告警…）。
   *
   * ⚠️ 与 `message` 的分工：这里是**用户要采取行动**的（"3 行缺订单号"意味着这批单少录了），
   * 界面上**直接平铺**、不折叠；而 `message` 是排查用的判据，默认折叠在「怎么看出来的」里。
   * 空数组 = 一切正常，界面一个字都不写（不写"无异常"—— 那种话不携带信息）。
   */
  warnings: string[];
  /** 下一步动作（空数组 = 这页没有可点的下一步，界面不渲按钮组） */
  next: ImportNextStep[];
  /** 落库明细（各类型形状不同；界面只展示 message） */
  detail?: unknown;
}

/**
 * **统一导入**：判断这份 Excel 是什么，并落到对的表。
 *
 * @returns 识别结论 + 是否落库 + **两层文案**：`headline`（大字结论，一行说清结果）、
 * `warnings`（要用户管的异常，没有就是空数组）、`message`（判据，界面折叠）。**识别结果永远回传**
 * （判据 `why` 一并给），于是"导到哪去了"在界面上是可核对的，不是一个黑盒。
 */
export async function detectAndImport(src: ImportSource): Promise<AutoImportResult> {
  const { sheetNames, grids } = await readWorkbookSheets(src);
  if (!sheetNames.length) throw new Error('Excel 内没有工作表');
  const det = detectImportKind(grids);
  if (det.kind === null) {
    // 两种"没写库"要分开：① 认出来了但这类文件不该导（商品信息表）→ 给一个真入口；
    // ② 真没认出来 → 不给按钮（没有"下一步"可点，硬塞一个只会把人送去瞎点）。
    const itemInfo = det.variant === 'item-info';
    return {
      kind: null,
      sheetName: '',
      why: '没有命中任何已知类型',
      scanned: det.scanned,
      wrote: false,
      title: itemInfo ? '「商品信息」表' : '没认出这份文件',
      // 「结论」与「标题」在这两种情况下很容易写成同一句话（都"没动数据"）——
      // 刻意让它们各司其职：标题回答**这是什么**，结论回答**结果如何**。
      // 写成两句一样的话（标题「没认出这份文件」+ 结论「没认出这份文件」）会在卡片上
      // 上下重复一遍，正是用户说的"文字太多"里最没信息量的一种。
      headline: itemInfo ? '这类文件不用导入' : '这份文件没有导入',
      landed: null,
      warnings: [],
      next: itemInfo
        ? [{ label: '去「产品管理」维护 SKU 克重', moduleId: 'shop-accounts', action: 'goods', primary: true }]
        : [],
      message: itemInfo
        ? // 认出来了就说认出来了 —— 复用"没认出这个文件是什么"那句会让标题与明细自相矛盾
          // （界面截图里真看出来了：标题写「商品信息」表、正文却写"没认出"）
          '这是「商品信息」表 —— 这类文件不用再导入：克重属于 SKU（一款不同颜色/尺码可能不同），请在「基础数据 › 产品管理」里按 SKU 维护'
        : `没认出这个文件是什么。逐张体检：${det.scanned.join('；') || '无工作表'}`,
    };
  }

  if (det.kind === 'orders') {
    const r = await importOrders(src);
    // 店铺：报表带「店铺名」列（芒果店长式）→ 已直接落库；没有该列（AE 按店铺导出）→ 提示去「统计」归一次
    const shopNote = r.shops.length
      ? `；店铺已归属：${r.shops.slice(0, 3).join('、')}${r.shops.length > 3 ? ` 等 ${r.shops.length} 家` : ''}`
      : '；店铺未归属 —— 可在「统计」页一次「归到该店」';
    /**
     * **异常行**（只有真的发生才写，界面上直接平铺）。
     *
     * 判据（2026-10-11）：一件事进不进来，看**用户要不要为它做点什么**。
     *   · 「跳过 N 行」要 —— 这批单少录了，用户得回去看报表；
     *   · 「主图没下来」要 —— 订单进了库但没图，拣货单与导出给厂家的表里这几行没图；
     *   · 「拆了 N 行」**不要** —— 那是系统的正常动作，用户不需要做任何事（它进 `message`）。
     * ⚠️ 顺序 = 严重度：先"没进来的"，再"进来了但缺东西的"。
     */
    const warnings: string[] = [];
    if (r.skipped) warnings.push(`${r.skipped} 行没有订单号，已跳过（这几行没进库）`);
    if (r.imageFailed) warnings.push(`${r.imageFailed} 行主图没下下来（订单进了库，但这几行没有图）`);
    return {
      ...det,
      wrote: r.inserted > 0,
      detail: r,
      title: det.variant || '订单报表',
      headline: r.inserted > 0 ? `已导入 ${r.inserted} 行订单` : '没有新增订单',
      landed: {
        label: '订单',
        // 三处都是用户真的看得到的地方（顺序 = 从"刚导完最该看"到"再往后"）。
        // ⚠️ 2026-10-05「发货台」改造后，拣货/算钱是**同一个「发货台」页里的页签**，
        //    不再是两个要跳过去的页面 —— 文案跟着改，否则用户会以为还要切走。
        // 2026-10-10：拣货清单并进「拿货」（第 3 步 → 第 4 步）⇒ 这里的去处名跟着改。
        // 2026-10-11：**第 2 步「归类核对」排在最前** —— 刚导完的行大概率还没归款，
        //    那才是"接着该看的那一屏"（这一改动同时修掉了回执主按钮与流程卡第 2 步的矛盾，见下）。
        // ⚠️ 2026-10-17：算钱整步撤出发货台（改名「统计」）⇒ 前两处仍是**本页页签**，
        //    第三处变成**独立模块**（写「统计」页，不写页签 —— 用户不会在本页找到它）。
        views: ['「归类核对」页签', '「拿货」页签', '「统计」页'],
      },
      warnings,
      // 「下一步」按场景给：主操作**永远是"去核对这些行"**（第 2 步），
      // ⚠️ 这条在 2026-10-11 前是「去「拿货」页签」（第 4 步）—— 与流程卡上"第 2 步才是当前步"
      //    自相矛盾：卡片让用户去归类，回执却把人直接送到拿货。现在两处一致。
      // 第二格按场景分叉：店铺已归属 → 去「拿货」页签（第 3 步）；未归属（AE 按店铺导出）
      //    → 先去「统计」把店铺归了（那里才是归属动作所在，见 `message` 的 `shopNote`）。
      // ⚠️ 页签的用 `tab`（就地切页签）、模块的用 `moduleId`（真跳转）：前两格都在「发货台」
      //    本页里，写 `moduleId` 会把人**跳出这个页面**；而「统计」（id `order-cost`）是独立
      //    模块 —— 2026-10-17 算钱整步撤出发货台后，归属/利润那一格只能写 `moduleId`。
      next: r.shops.length
        ? [
            { label: '去核对这些行', tab: 'classify', primary: true },
            { label: '去「拿货」页签', tab: 'purchase' },
          ]
        : [
            { label: '去核对这些行', tab: 'classify', primary: true },
            { label: '去「统计」归店铺', moduleId: 'order-cost' },
          ],
      message:
        `识别为「订单报表」（${det.why}）→ 已导入 ${r.inserted} 行` +
        (r.expanded ? `（${r.expanded} 个多产品单已拆行）` : '') +
        (r.skipped ? `，跳过 ${r.skipped} 行` : '') +
        (r.images ? `，主图 ${r.images} 张` : '') +
        (r.imageFailed ? `，${r.imageFailed} 行主图下载失败（已按无图入库）` : '') +
        shopNote,
    };
  }

  if (det.kind === 'settle') {
    const r = await importSettle(src);
    return {
      ...det,
      wrote: true,
      detail: r,
      title: '结算明细',
      headline: `已导入结算明细 · 新增 ${r.created} / 更新 ${r.updated}`,
      landed: { label: '结算明细', views: ['「统计」页（结算轨）'] },
      warnings: [
        ...(r.failed.length ? [`${r.failed.length} 行没导进去（订单号对不上，详见技术明细）`] : []),
        ...(r.issues ? [`${r.issues} 行等式校验没通过（平台口径可能变了）`] : []),
      ],
      next: [{ label: '去「统计」看毛利', moduleId: 'order-cost', primary: true }],
      message:
        `识别为「结算明细」（${det.why}）→ 已导入：新增 ${r.created} / 更新 ${r.updated}` +
        (r.failed.length ? `，失败 ${r.failed.length} 行` : '') +
        (r.issues ? `；${r.issues} 行等式校验告警（见控制台）` : ''),
    };
  }

  const r = await importRateSheet(src);
  const kept = r.snapshotId > 0;
  return {
    ...det,
    wrote: kept,
    detail: r,
    title: '报价单（运价表）',
    headline: kept ? `运价表已留档（快照 #${r.snapshotId}）` : '没挑出一张能用的表',
    // 没挑出可用的表 = 这个字节都没留档 → **不给落点也不给下一步**（免得用户以为"已经进去了"）
    landed: kept ? { label: '运价表', views: ['「统计」页（按生效日取用）'] } : null,
    warnings: [],
    next: kept ? [{ label: '去「统计」核对', moduleId: 'order-cost', primary: true }] : [],
    message:
      `识别为「报价单」（${det.why}）→ 取表「${r.sheetName}」` +
      (kept ? `，已留档（快照 #${r.snapshotId}）` : '，但没挑出一张能用的表（请检查报价单格式）'),
  };
}

/** 网格 → 逐行对象（与既有解析器吃同一种形状；仅本服务内部用） */
function gridToRecords(grid: unknown[][]): Record<string, string>[] {
  const header = (grid?.[0] ?? []).map((h) => String(h ?? '').trim());
  return grid.slice(1).map((r) => Object.fromEntries(header.map((k, i) => [k, String(r?.[i] ?? '')])));
}