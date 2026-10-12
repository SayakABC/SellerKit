// 货与成本 · Excel 导入 / 导出编排（渲染层）
//
// 这段逻辑原本活在市场分发的 UI 岛 `ui-plugins/product-library` 里，经宿主 `DB_OPS` 的
// `product-admin.importProducts` / `exportExcel` 由主进程代劳 —— 因为**岛跑在 iframe 里**：
// 文档 CSP 无 `'unsafe-eval'`、又没有构建步骤（引不了 `xlsx`），"读文件 + 解析 + 校验"
// 只能宿主做。
//
// 功能收回内建（2026-10-01）后这层理由消失了：渲染层本来就能 `import('xlsx')`，也能直接调
// `ipc.*`，于是把整段编排搬到渲染层。**纯函数仍然只有一份**（`@/lib/productImport` 的
// `parseProductRows` / `validateImportRows` / `buildProductSheet`）—— 宿主侧的 `DB_OPS` 桥
// 随岛一起删了，但 `product-import` / `product-export` 两个 IPC 通道仍在，主进程那侧只负责
// "收已校验好的行落库"与"弹框写文件"，解析口径依旧唯一且可被 vitest 覆盖。
import {
  attachExtractedImages,
  buildProductSheetLayout,
  parseProductRows,
  PRODUCT_EXPORT_HEADERS,
  validateImportRows,
} from '@/lib/productImport';
import type {
  ProductExportRow,
  ProductImportIssue,
  ProductImportRowResult,
} from '@/lib/productImport';
import * as ipc from '@/core/services/ipc';
import type { ExcelFilePayload } from '@/core/services/ipc';
import { pickUnitCost } from '@/lib/orderCost';
import type { CostInterval } from '@/lib/orderCost';
import { localDayKey } from '@/lib/localDay';
import { unwrapApi, isCanceled } from './unwrapApi';

/* ============================================================================
   文件选择（对话框）—— 取消是正常行为，返回 null 而不是抛异常
   ============================================================================ */

/**
 * 让用户选一份 Excel。
 *
 * `select-excel` **顺手把文件读进内存**（返回 `{ filePath, data }`），所以这里直接把
 * payload 交给下游解析 —— 不要再拿 `filePath` 调一次 `importExcelByPath` 重读一遍
 * （大点的报价单工作簿会白读一次几十 MB）。
 *
 * 用户取消时主进程回 `{success:false, error:'User canceled'}` → 这里返回 `null`，
 * 调用方 `if (!file) return` 即可，不会弹出"导入失败：User canceled"。
 */
export async function pickExcel(): Promise<ExcelFilePayload | null> {
  const r = await ipc.selectExcel();
  if (isCanceled(r)) return null;
  const file = unwrapApi(r);
  return file?.filePath ? file : null;
}

/** 让用户选一张图片。取消返回 null（只回路径，不读内容 —— 由写通道自行拷贝进缓存）。 */
export async function pickImage(): Promise<string | null> {
  const r = await ipc.selectImage();
  if (isCanceled(r)) return null;
  const sel = unwrapApi(r);
  return sel?.filePath || null;
}

/** 「我是怎么读这份文件的」的取证 —— 读错表时，这是唯一的排查线索 */
export interface ProductImportOrigin {
  sheetNames: string[];
  /** 实际采用的工作表（逐张体检后取"可用行数最多"的那张，**不写死第一张**） */
  pickedSheet: string;
  /** 每张表的体检结论（`表名:结论`） */
  scanned: string[];
  /** 表头所在行（1-based，供用户回表核对） */
  headerRow: number;
  headers: string[];
  blankRows: number;
}

export interface ProductImportPreview {
  rows: ProductImportRowResult[];
  issues: ProductImportIssue[];
  origin: ProductImportOrigin;
  /** error 级 issue 数（warning 不计） */
  errors: number;
  warnings: number;
  /** 文件里一共抽到几张嵌入图 / 其中几张归到了数据行 */
  imagesFound: number;
  imagesLocated: number;
}

export interface ProductImportCommitResult {
  rows: ProductImportRowResult[];
  issues: ProductImportIssue[];
  errors: number;
  warnings: number;
  created: number;
  updated: number;
  /** 本次写库的 SKU 条数 */
  skusWritten: number;
  /** 本次设为款主图的张数 */
  imagesAttached: number;
  /** 本次写入 `ae_cost_map` 的手工进价条数 */
  costsWritten: number;
  /** 因与现价相同（幂等）或未填而跳过的进价条数 */
  costsSkipped: number;
  /** 本次**新建**的供应商条数（2026-10-10） */
  suppliersCreated: number;
  /** 库层才拦得住的失败行（如 insertOnly 下编码已存在） */
  failed: { rowNo: number; code: string; message: string }[];
  /**
   * 因「同名款：跳过不覆盖」而**没有提交**的行（2026-10-10）。
   * 与 `failed` 分开：这些行不是错了，是用户按自己的选择留下的。
   */
  skippedByName: { rowNo: number; code: string; name: string }[];
}

/** 「同名款（款式名在库内已存在）」的处理方式；默认覆盖 = 沿用库内编码更新那一款 */
export type SameNameMode = 'overwrite' | 'skip';

/** 本地日期 `yyyy-mm-dd` —— 手工进价的生效日（口径：**导入当日**，见 `product-cost-sync.ts`）。
 *  实现收敛在 `@/lib/localDay`（三处"今天"共用一份，见该文件注释）。 */
export function todayKey(): string {
  return localDayKey();
}

/** 导出翻页护栏：每页与主进程 `product-db` 的 `MAX_LIST_LIMIT` 一致，最多 40 页 = 2 万行 */
const EXPORT_PAGE = 500;
const EXPORT_MAX_PAGES = 40;

/** 供应商参照表（按名称对 id 用）。`summary` 的 `supplierOptions` 是**全量**供应商。 */
async function supplierRefs(): Promise<{ id: number; name: string }[]> {
  const s = unwrapApi(await ipc.productSummary());
  return (s?.supplierOptions ?? []).map((x) => ({ id: x.id, name: x.name }));
}

/** 库内已有产品的两个索引（同一趟分页取回，别读两遍） */
interface ExistingProductIndex {
  /** 全部款编码（自动生成编码时做碰撞防护） */
  codes: Set<string>;
  /** 款式名（归一：去空白 + 小写）→ 款编码（同名款判定 + 编码回显） */
  codeByName: Map<string, string>;
}

/** 款式名归一 —— 与 `@/lib/productImport` 的 `normStyleName` **同一套口径**（两侧判据必须一致） */
function normStyleName(v: unknown): string {
  return String(v ?? '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * 取库内已有产品的编码集合 + 款式名索引。
 *
 * 为什么两个索引一起建：`productList` 是**分页**读的（最多 40 页 = 2 万款），
 * 为两个用途各扫一遍等于把整库读两次。命名也照旧（`existingProductCodes` 的老调用点只关心编码）。
 *
 * 同名时保留**先出现**的那条（`productList` 按 id 升序）—— 重名款是数据问题，不是这里能修的；
 * 但"回显哪一个"必须是确定性的，否则同一份文件导两次结果不一样。
 */
async function existingProductIndex(): Promise<ExistingProductIndex> {
  const codes = new Set<string>();
  const codeByName = new Map<string, string>();
  // 分页取全量（最多 40 页 = 2 万款）
  for (let page = 0; page < 40; page++) {
    const res = unwrapApi(
      await ipc.productList({ offset: page * 500, limit: 500, search: '', status: '', supplierId: 0 })
    );
    for (const r of res?.rows ?? []) {
      if (r.code) codes.add(r.code);
      const key = normStyleName(r.name);
      if (key && r.code && !codeByName.has(key)) codeByName.set(key, r.code);
    }
    if (codes.size >= (res?.total ?? 0) || !(res?.rows ?? []).length) break;
  }
  return { codes, codeByName };
}

interface SheetRead {
  rows: ProductImportRowResult[];
  issues: ProductImportIssue[];
  origin: ProductImportOrigin;
}

/**
 * 逐张工作表体检，取"可用行数最多"的那张。
 *
 * ⚠️ **不按位置取工作表**：导出的 xlsx 首张常是说明页，`sheets[0]` 会把「读错对象」
 *    伪装成「对象本身有问题」（历史踩过：21 张表的工作簿，目标表在第 10 张）。
 *    每张的结论都留进 `origin.scanned`，读不到时界面才有话可说。
 *
 * 读不出任何产品表时返回 `null`，并把体检结论一并带出（错误文案要用）。
 */
async function readProductSheet(
  buffer: ArrayBuffer,
  suppliers: { id: number; name: string }[],
  existingCodes: ReadonlySet<string>,
  existingNames: ReadonlyMap<string, string>
): Promise<{ read: SheetRead } | { read: null; scanned: string[]; sheetNames: string[] }> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheetNames = wb.SheetNames ?? [];

  const scanned: string[] = [];
  let best: { sheetName: string; result: ReturnType<typeof parseProductRows> } | null = null;

  for (const name of sheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1,
      defval: '',
    }) as unknown[][];
    const parsed = parseProductRows(sheetRows, suppliers, existingCodes, existingNames);
    if (parsed.headerRow === -1) {
      scanned.push(`${name}:表头无「编码 + 名称」列`);
      continue;
    }
    scanned.push(`${name}:${parsed.rows.length} 行`);
    if (!best || parsed.rows.length > best.result.rows.length) {
      best = { sheetName: name, result: parsed };
    }
  }

  if (!best) return { read: null, scanned, sheetNames };
  return {
    read: {
      rows: best.result.rows,
      issues: best.result.issues,
      origin: {
        sheetNames,
        pickedSheet: best.sheetName,
        scanned,
        headerRow: best.result.headerRow + 1,
        headers: best.result.headers,
        blankRows: best.result.blankRows,
      },
    },
  };
}

/**
 * 第一遍：读 Excel、逐张体检、列名匹配、逐行校验、**抽嵌入图**。**不落库**。
 *
 * 为什么必须有这一遍：导入的既定形态是"逐行校验、错误行可在界面修正后重试"。
 * 直接落库的话，不合格行只能靠事后比对去找，用户拿不到改的机会。
 *
 * 图的抽取**排在解析之后**、且**失败不算导入失败**：
 *   · 排后面：浮动图的锚点要跟"数据行从第几行开始"比，而"哪张表是产品表、表头在第几行"
 *     只有解析完才知道（表头允许不在第一行，工作表也可能是第二张）；
 *   · 不算失败：图是附加信息，产品字段该进的还是要进。但**必须留下一句话** ——
 *     "导入成功了但一张图都没有"如果不报，用户只会以为是自己 Excel 里没贴图。
 */
export async function previewProductImport(file: ExcelFilePayload): Promise<ProductImportPreview> {
  // 库内索引先取一次，供解析使用（同名款判定 + 编码回显 + 自动生成的碰撞防护都靠它）
  const suppliers = await supplierRefs();
  const { codes, codeByName } = await existingProductIndex();
  const res = await readProductSheet(file.data, suppliers, codes, codeByName);
  if (!res.read) {
    throw new Error(
      `Excel 内没有可识别的产品表（逐张体检：${res.scanned.join('；') || '无工作表'}）`
    );
  }

  let rows = res.read.rows;
  let issues = res.read.issues;
  let imagesFound = 0;
  let imagesLocated = 0;
  try {
    const ex = unwrapApi(
      await ipc.productExtractImages({
        buffer: file.data,
        sheetName: res.read.origin.pickedSheet,
        headerRow: res.read.origin.headerRow,
      })
    );
    const merged = attachExtractedImages(rows, ex?.byRow, ex?.skips);
    rows = merged.rows;
    issues = [...issues, ...merged.issues];
    imagesFound = Number(ex?.total) || 0;
    imagesLocated = Object.keys(ex?.byRow ?? {}).length;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    issues = [
      ...issues,
      {
        rowNo: 0,
        code: '',
        level: 'warning',
        message: `没能从文件里读取图片：${msg} —— 产品信息照常导入，图片需要导入后在界面上补`,
      },
    ];
  }

  const errors = issues.filter((x) => x.level === 'error').length;
  return {
    rows,
    issues,
    origin: res.read.origin,
    errors,
    warnings: issues.length - errors,
    imagesFound,
    imagesLocated,
  };
}

/**
 * 第二遍：把界面上（可能已改过）的行回传提交。
 *
 * ⚠️ 界面的本地判定只用于**即时反馈**，不是放行依据 —— 这里把**全部行**（含不合格）
 *    都交给 `validateImportRows` 重新裁决，只有 `ok` 的行才落到 `productImport`。
 *    只落合格行，不合格行**不静默丢掉**：它们随返回值回到界面标红，用户改完再提交一次。
 */
export async function commitProductImport(
  rows: ProductImportRowResult[],
  mode: 'upsert' | 'insertOnly',
  sameName: SameNameMode = 'overwrite',
): Promise<ProductImportCommitResult> {
  const suppliers = await supplierRefs();
  const { codes: existingCodes, codeByName } = await existingProductIndex();
  const v = validateImportRows(rows, suppliers, existingCodes, codeByName);
  const errors = v.issues.filter((x) => x.level === 'error').length;

  // 「同名款：跳过」—— 只拦**用户点名要跳过的那一类**（款式名在库内已存在），
  // 其余行照常提交。被判跳过的行随返回值回到界面（不是消失），用户能看见自己放弃了哪几行。
  const skippedByName =
    sameName === 'skip'
      ? v.rows
          .filter((x) => x.ok && x.nameMatched)
          .map((x) => ({ rowNo: x.rowNo, code: x.code, name: x.name }))
      : [];
  const skipRowNos = new Set(skippedByName.map((x) => x.rowNo));

  const submittable = v.rows.filter((x) => x.ok && !skipRowNos.has(x.rowNo));
  const save = submittable.length
    ? unwrapApi(
        await ipc.productImport({
          items: submittable.map((x) => ({
            rowNo: x.rowNo,
            code: x.code,
            name: x.name,
            supplierId: x.supplierId,
            // 供应商原文一并带上：库里没有这个名字时主进程要**按它新建**（2026-10-10）。
            // 只带 id 的话"名字对不上"就只剩一个 0，新建这件事根本无从执行。
            supplierRaw: x.supplierRaw,
            status: x.status,
            note: x.note,
            // SKU 与图都在这一层带走：`imageId` 是抽图那步贴到行上的，
            // `skus` 是解析（或界面回改）后的归一形态 —— 库层不再认识"单元格"这种东西。
            skus: x.skus.map((s) => ({ color: s.color, size: s.size, weightG: s.weightG })),
            imageId: x.imageId,
            // 手工进价（**分**）：`null` = 这行没填 ⇒ 主进程**不修改**库内已有价（不是清 0）。
            // 生效日 = 导入当日 —— 改价只影响此后的订单，历史订单按区间回查仍取旧价。
            costCents: x.costCents,
          })),
          mode,
          effectiveFrom: todayKey(),
        })
      )
    : {
        created: 0,
        updated: 0,
        skusWritten: 0,
        imagesAttached: 0,
        costsWritten: 0,
        costsSkipped: 0,
        suppliersCreated: 0,
        failed: [],
      };

  return {
    rows: v.rows,
    issues: v.issues,
    errors,
    warnings: v.issues.length - errors,
    created: save?.created ?? 0,
    updated: save?.updated ?? 0,
    skusWritten: save?.skusWritten ?? 0,
    imagesAttached: save?.imagesAttached ?? 0,
    costsWritten: save?.costsWritten ?? 0,
    costsSkipped: save?.costsSkipped ?? 0,
    suppliersCreated: save?.suppliersCreated ?? 0,
    failed: save?.failed ?? [],
    skippedByName,
  };
}

/**
 * 导出产品表 / 生成导入模板（`template: true` 只出表头）。
 *
 * 默认导出**当前筛选下的全部行**，不是界面这一页 —— 分页是展示需要，导出要完整数据。
 *
 * 分工（2026-10-08 改）：本函数只算**每格写什么**（`buildProductSheetLayout`，纯函数、有单测），
 * xlsx 由**主进程**用 exceljs 生成 —— 因为「图片」列里要嵌真图，而嵌入图是浮动对象
 * （`xl/drawings` + 关系 + 内容类型），渲染层用的 SheetJS 写不了。
 * 于是"导出 → 改 → 导回"的闭环里，图和文字都是同一份口径出来的。
 *
 * `template: true` 时**不拉数据**：模板只有表头，拉两万行只为丢掉是白费功夫。
 */
export async function exportProducts(opts: {
  template?: boolean;
  search?: string;
  status?: 'active' | 'archived' | '';
  supplierId?: number;
}): Promise<{ filePath: string; embedded: number; imagesFailed: number }> {
  const template = opts.template === true;
  const rows: ProductExportRow[] = [];
  /** 款编码 → 产品 id（补 SKU 那一步要用；编码 UNIQUE，用 Map 不会撞） */
  const idByCode = new Map<string, number>();

  if (!template) {
    for (let page = 0; page < EXPORT_MAX_PAGES; page++) {
      const res = unwrapApi(
        await ipc.productList({
          offset: page * EXPORT_PAGE,
          limit: EXPORT_PAGE,
          search: opts.search ?? '',
          status: opts.status ?? '',
          supplierId: Number(opts.supplierId) || 0,
        })
      );
      for (const r of res?.rows ?? []) {
        rows.push({
          code: r.code,
          name: r.name,
          supplierName: r.supplierName,
          // 主图的**本地缓存路径**：主进程按它嵌图（不新增"原始网址"列 —— 同机往返离线可用）
          imagePath: r.imagePath ?? '',
          status: r.status,
          note: r.note,
          // 进价在 `fillExportCosts` 里补（要跨域读 `ae_cost_map`）；这里先占位
          costCents: null,
          skus: [],
        });
        idByCode.set(r.code, r.id);
      }
      if (rows.length >= (res?.total ?? 0) || !(res?.rows ?? []).length) break;
    }
    await fillExportSkus(rows, idByCode);
    await fillExportCosts(rows);
  }

  const layout = buildProductSheetLayout(rows, template);
  const headers = layout.length ? layout[0].cells : [];
  const body = layout.slice(1).map((r) => ({ cells: r.cells, imagePath: r.imagePath }));
  const imageColumn = PRODUCT_EXPORT_HEADERS.indexOf('图片');

  const stamp = new Date().toISOString().slice(0, 10);
  return unwrapApi(
    await ipc.productExport({
      sheetName: template ? '导入模板' : '产品库',
      headers,
      rows: body,
      imageColumn: imageColumn === -1 ? 0 : imageColumn,
      defaultName: template ? '产品库导入模板.xlsx' : `产品库_${stamp}.xlsx`,
    })
  );
}

/** 一次批量取 SKU 的产品数上限（`product-variant-list` 自身的护栏是 5000） */
const EXPORT_SKU_BATCH = 1000;

/**
 * 给导出行补上各自的 SKU（颜色/尺码/克重）。
 *
 * 为什么是**分批一次取**而不是逐款取：导出 2000 款就是 2000 次 IPC，界面会长时间无响应；
 * 而 `product-variant-list` 本来就收 `productIds[]`（编辑抽屉也是这么用的）。
 * 取不到时**不报错** —— 那一列空着比"导出整个失败"更接近事实（款确实在，只是还没维护 SKU）。
 */
async function fillExportSkus(
  rows: ProductExportRow[],
  idByCode: ReadonlyMap<string, number>
): Promise<void> {
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const entries = [...idByCode.entries()];
  for (let i = 0; i < entries.length; i += EXPORT_SKU_BATCH) {
    const slice = entries.slice(i, i + EXPORT_SKU_BATCH);
    let got: { productId: number; color: string; size: string; weightG: number }[] = [];
    try {
      const res = unwrapApi(await ipc.productVariantList(slice.map(([, id]) => id)));
      got = (res?.rows ?? []).map((v) => ({
        productId: v.productId,
        color: v.color,
        size: v.size,
        weightG: v.weightG,
      }));
    } catch {
      continue; // 这一批没拿到 → 这些款的 SKU 列空着，其余照常
    }
    const codeById = new Map(slice.map(([code, id]) => [id, code]));
    for (const v of got) {
      const code = codeById.get(v.productId);
      if (!code) continue;
      byCode.get(code)?.skus.push({ color: v.color, size: v.size, weightG: v.weightG });
    }
  }
}

/**
 * 给导出行补上**当前生效进价**（分）。
 *
 * 口径与**算钱 / 拣货两页完全一致**：一次读全 `ae_cost_map`，用 `pickUnitCost` 按业务日期取
 * 该款当时生效的那条（同一天 manual 优先）。这里业务日期取**今天** —— 「当前价」就是这个意思；
 * 改价后历史订单仍按各自的下单日期回查到旧价（区间口径，不是快照）。
 *
 * 取不到**不报错**：那一列空着比"导出整个失败"更接近事实（款确实在，只是还没维护进价）。
 */
async function fillExportCosts(rows: ProductExportRow[]): Promise<void> {
  if (!rows.length) return;
  let costs: CostInterval[] = [];
  try {
    const c = unwrapApi(await ipc.aeCostMapList());
    costs = (c ?? []).map((x) => ({
      styleCode: String(x.styleCode ?? ''),
      effectiveFrom: String(x.effectiveFrom ?? ''),
      unitPrice: (Number(x.unitPriceCents) || 0) / 100,
      source: String(x.source ?? ''),
    }));
  } catch {
    return; // 读不到成本 → 进价列全空，导出照常
  }
  const today = todayKey();
  for (const r of rows) {
    const unit = pickUnitCost(costs, r.code, today);
    r.costCents = unit === null ? null : Math.round(unit * 100);
  }
}

/**
 * 读一份"商品清单"Excel（商品ID + 产品图片链接），供「商品清单」页签导入。
 *
 * 与产品导入的区别：这里只取两列，且**没有校验环节** —— 商品清单是原始池子，
 * 未关联的商品本来就该进来排队等人工确认，拦下来只会让人以为"导入失败"。
 */
export async function readShopProductFile(
  file: ExcelFilePayload
): Promise<{ itemId: string; shopId: number; imageUrl: string }[]> {
  const { parseExcelBuffer } = await import('@/core/services/excel');
  const parsed = parseExcelBuffer(file.data);

  const items = (parsed.records ?? [])
    .map((r) => {
      // `RecordItem` 是"表头 → 单元格"的索引签名，但 TS 认为两者不重叠 —— 先过 unknown
      const row = r as unknown as Record<string, unknown>;
      return {
        itemId: String(row['产品ID'] ?? '').trim(),
        shopId: 0, // 店铺归属后续按店铺清单匹配；这里不猜（猜错会把两家店并到一起）
        imageUrl: String(row['产品图片链接'] ?? '').trim(),
      };
    })
    .filter((x) => x.itemId);

  // 按 item_id 去重：同 ID 出现多次时保留后者（视作较新的那条）
  const unique = new Map<string, { itemId: string; shopId: number; imageUrl: string }>();
  for (const it of items) unique.set(it.itemId, it);
  return [...unique.values()];
}
