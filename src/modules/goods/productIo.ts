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
import { parseProductRows, validateImportRows, buildProductSheet } from '@/lib/productImport';
import type {
  ProductExportRow,
  ProductImportIssue,
  ProductImportRowResult,
} from '@/lib/productImport';
import * as ipc from '@/core/services/ipc';
import type { ExcelFilePayload } from '@/core/services/ipc';
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
}

export interface ProductImportCommitResult {
  rows: ProductImportRowResult[];
  issues: ProductImportIssue[];
  errors: number;
  warnings: number;
  created: number;
  updated: number;
  /** 库层才拦得住的失败行（如 insertOnly 下编码已存在） */
  failed: { rowNo: number; code: string; message: string }[];
}

/** 导出翻页护栏：每页与主进程 `product-db` 的 `MAX_LIST_LIMIT` 一致，最多 40 页 = 2 万行 */
const EXPORT_PAGE = 500;
const EXPORT_MAX_PAGES = 40;

/** 供应商参照表（按名称对 id 用）。`summary` 的 `supplierOptions` 是**全量**供应商。 */
async function supplierRefs(): Promise<{ id: number; name: string }[]> {
  const s = unwrapApi(await ipc.productSummary());
  return (s?.supplierOptions ?? []).map((x) => ({ id: x.id, name: x.name }));
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
  buffer: ArrayBuffer
): Promise<{ read: SheetRead } | { read: null; scanned: string[]; sheetNames: string[] }> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheetNames = wb.SheetNames ?? [];
  const suppliers = await supplierRefs();

  const scanned: string[] = [];
  let best: { sheetName: string; result: ReturnType<typeof parseProductRows> } | null = null;

  for (const name of sheetNames) {
    const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1,
      defval: '',
    }) as unknown[][];
    const parsed = parseProductRows(sheetRows, suppliers);
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
 * 第一遍：读 Excel、逐张体检、列名匹配、逐行校验。**不落库**。
 *
 * 为什么必须有这一遍：导入的既定形态是"逐行校验、错误行可在界面修正后重试"。
 * 直接落库的话，不合格行只能靠事后比对去找，用户拿不到改的机会。
 */
export async function previewProductImport(file: ExcelFilePayload): Promise<ProductImportPreview> {
  const res = await readProductSheet(file.data);
  if (!res.read) {
    throw new Error(
      `Excel 内没有可识别的产品表（逐张体检：${res.scanned.join('；') || '无工作表'}）`
    );
  }
  const errors = res.read.issues.filter((x) => x.level === 'error').length;
  return {
    rows: res.read.rows,
    issues: res.read.issues,
    origin: res.read.origin,
    errors,
    warnings: res.read.issues.length - errors,
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
  mode: 'upsert' | 'insertOnly'
): Promise<ProductImportCommitResult> {
  const suppliers = await supplierRefs();
  const v = validateImportRows(rows, suppliers);
  const errors = v.issues.filter((x) => x.level === 'error').length;

  const submittable = v.rows.filter((x) => x.ok);
  const save = submittable.length
    ? unwrapApi(
        await ipc.productImport({
          items: submittable.map((x) => ({
            rowNo: x.rowNo,
            code: x.code,
            name: x.name,
            supplierId: x.supplierId,
            category: x.category,
            status: x.status,
            note: x.note,
          })),
          mode,
        })
      )
    : { created: 0, updated: 0, failed: [] };

  return {
    rows: v.rows,
    issues: v.issues,
    errors,
    warnings: v.issues.length - errors,
    created: save?.created ?? 0,
    updated: save?.updated ?? 0,
    failed: save?.failed ?? [],
  };
}

/**
 * 导出产品表 / 生成导入模板（`template: true` 只出表头）。
 *
 * 默认导出**当前筛选下的全部行**，不是界面这一页 —— 分页是展示需要，导出要完整数据。
 * 与宿主落库侧的 `product-export` 通道同一套口径（都在 `@/lib/productImport` 里取表头与行，
 * 含同样的翻页护栏）。
 */
export async function exportProducts(opts: {
  template?: boolean;
  search?: string;
  status?: 'active' | 'archived' | '';
  supplierId?: number;
}): Promise<{ filePath: string }> {
  const template = opts.template === true;
  const rows: ProductExportRow[] = [];

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
          category: r.category,
          status: r.status,
          note: r.note,
        });
      }
      if (rows.length >= (res?.total ?? 0) || !(res?.rows ?? []).length) break;
    }
  }

  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(buildProductSheet(rows, template)),
    template ? '导入模板' : '产品库'
  );
  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  const stamp = new Date().toISOString().slice(0, 10);
  return unwrapApi(
    await ipc.productExport({
      buffer,
      defaultName: template ? '产品库导入模板.xlsx' : `产品库_${stamp}.xlsx`,
    })
  );
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
