// src/lib/productImport.ts
// 产品库 Excel 导入：解析 + 逐行校验（**纯函数**，宿主渲染层侧）。
//
// 为什么解析放这里而不是主进程 `electron/product-db.ts`：
//   ① 三层边界要求主进程不 import 渲染层代码（AGENTS.md §1.1）；
//   ② 口径只能有一份 —— 「哪列是编码」「厂家名怎么对 id」「状态怎么认」若岛侧再实现一遍，
//      两端口径必然漂移（与 shipping-rate 的归一化同一原则）；
//   ③ 纯函数可被 vitest 直接覆盖，而碰 SQLite 的那层测不了（better-sqlite3 是 Electron ABI）。
// 岛侧因此只负责「选文件 → 调宿主 op → 渲染逐行结果」。
//
// 两条调用路径共用 `validateImportRows`：
//   · 首次导入：`parseProductRows`（列名匹配 → 校验）
//   · 失败行改完后重试：岛把行回传，宿主只调 `validateImportRows`（不再做列名匹配）
// 两路共用同一个校验器是刻意的 —— 用户手改出来的「空编码」「重复编码」必须和 Excel 里的一样被拦。
//
// ⚠️ 校验结果返回**全部行**（含不合格行，带 `ok` 标记），而不是只返回能入库的那些。
//    原因：P2 验收要求「10 行可在界面重试」—— 岛得先拿到那 10 行的原始值才能让用户改。
//    只回合格的会让"重试"变成一个不可能实现的按钮。
//
// 本文件**不做**厂家名的模糊匹配：对不上就报 warning 并落成 `supplier_id = 0`。
// 静默把「厂家甲」猜成「厂家乙」会把成本/对账挂到别人账上，且界面上看不出异常。

/** 厂家的最小形状（id + 名称；来自 suppliers 表，由宿主注入） */
export interface SupplierRef {
  id: number;
  name: string;
}

/** 一行校验后的结果（字段已规整；`ok=false` 表示该行有 error，不会入库） */
export interface ProductImportRowResult {
  /** Excel 中的行号（1-based，含表头行，供用户回表核对） */
  rowNo: number;
  /** 是否可入库（false = 至少有一条 error 级 issue） */
  ok: boolean;
  code: string;
  name: string;
  /** 已解析出的厂家 id；0 = 未关联（未填或名称对不上） */
  supplierId: number;
  /** 厂家原文（名称对不上时用户要看的就是它） */
  supplierRaw: string;
  category: string;
  status: string;
  note: string;
}

/**
 * 逐行问题。
 * `error` 行**不入库**（该行被剔除，其余行照常导入）；`warning` 行照常入库，只是需要用户知晓。
 * 这个分级是刻意的：把「厂家名对不上」升级成 error 会让整批卡住，降级成静默又会让用户
 * 以为关联成功了 —— 两者都会让用户去怀疑数据本身。
 */
export interface ProductImportIssue {
  rowNo: number;
  /** 该行的编码（解析不出时为空串） */
  code: string;
  level: 'error' | 'warning';
  message: string;
}

export interface ProductImportColumns {
  code: number;
  name: number;
  supplier: number;
  category: number;
  status: number;
  note: number;
}

export interface ParseProductResult {
  /** 表头所在行（0-based）；-1 = 没找到表头 */
  headerRow: number;
  /** 命中的列号（-1 = 该列缺失，按空值处理） */
  columns: ProductImportColumns;
  /** 表头行的原文（界面回显「按这些列读的」） */
  headers: string[];
  /** 全部数据行（含不合格行） */
  rows: ProductImportRowResult[];
  issues: ProductImportIssue[];
  /** 由于整行为空而跳过的行数（Excel 尾部空行是常态，不计入 issues） */
  blankRows: number;
}

// ---------------------------------------------------------------------------
// 列名族
// ---------------------------------------------------------------------------

/**
 * 列名同义族。**只收真实出现过的写法**，宁缺毋滥 —— 加宽 `includes` 会把
 * 「类目编码」这类列误认成主键列，而错误很难在界面上看出来（数字看着都正常）。
 * 匹配顺序：先整列**精确**命中，再退到**包含**。
 */
const COLUMN_FAMILIES = {
  code: ['款编码', '产品编码', '商品编码', '内部编码', '编码', 'code'],
  name: ['款式名', '产品名称', '商品名称', '款式名称', '品名', '名称', 'name'],
  supplier: ['厂家名称', '供应商名称', '厂家', '供应商', 'supplier'],
  category: ['类目', '品类', '分类', 'category'],
  status: ['状态', 'status'],
  note: ['备注', '说明', 'note'],
} as const;

type FamilyKey = keyof typeof COLUMN_FAMILIES;

/** 表头归一：去空白 / 去 Excel 必填星号 / 去括号注记 / 转小写 */
function normHeader(v: unknown): string {
  return String(v ?? '')
    .replace(/\s+/g, '')
    .replace(/^\*+/, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .toLowerCase();
}

/** 单元格取文本（数字编码也当文本，避免 `1001` 与 `'1001'` 判成两行） */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v).trim();
}

const EMPTY_COLUMNS: ProductImportColumns = {
  code: -1,
  name: -1,
  supplier: -1,
  category: -1,
  status: -1,
  note: -1,
};

/**
 * 为每个族挑一列。
 * 已被前面族占用的列不会重复分配（同一列不会既是编码又是名称）。
 */
function resolveColumns(headerRow: unknown[]): ProductImportColumns {
  const norm = headerRow.map(normHeader);
  const taken = new Set<number>();
  const out: ProductImportColumns = { ...EMPTY_COLUMNS };

  const order: FamilyKey[] = ['code', 'name', 'supplier', 'category', 'status', 'note'];
  for (const key of order) {
    const family = COLUMN_FAMILIES[key].map(normHeader);
    let hit = -1;
    // ① 精确
    for (let i = 0; i < norm.length && hit === -1; i++) {
      if (taken.has(i) || !norm[i]) continue;
      if (family.includes(norm[i])) hit = i;
    }
    // ② 包含（长键优先：「产品编码」不该被「编码」在别的列上先抢走）
    if (hit === -1) {
      const keys = [...family].sort((a, b) => b.length - a.length);
      for (const k of keys) {
        if (hit !== -1) break;
        for (let i = 0; i < norm.length; i++) {
          if (taken.has(i) || !norm[i]) continue;
          if (norm[i].includes(k)) {
            hit = i;
            break;
          }
        }
      }
    }
    out[key] = hit;
    if (hit !== -1) taken.add(hit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 取值规整
// ---------------------------------------------------------------------------

/** 状态文本 → 枚举值（Excel 里中英文混填是常态）；认不出返回空串 */
const STATUS_TEXT: Record<string, string> = {
  active: 'active',
  archived: 'archived',
  启用: 'active',
  有效: 'active',
  正常: 'active',
  在售: 'active',
  停用: 'archived',
  停售: 'archived',
  归档: 'archived',
  已归档: 'archived',
  作废: 'archived',
};

/** 状态文本 → `active` / `archived`；认不出返回空串（由调用方决定降级还是报错） */
export function parseStatusText(raw: unknown): string {
  return STATUS_TEXT[cell(raw).replace(/\s+/g, '').toLowerCase()] ?? '';
}

const MAX = { code: 64, name: 200, category: 60, note: 2000 } as const;

/** 待校验行的形状（Excel 路径由 `parseProductRows` 构造；提交路径由岛回传） */
export interface ProductImportDraftRow {
  rowNo?: number;
  code?: unknown;
  name?: unknown;
  supplierId?: unknown;
  supplierRaw?: unknown;
  category?: unknown;
  status?: unknown;
  note?: unknown;
}

/** 厂家名归一（比较用）：去空白 + 小写 */
const normSupplierName = (v: unknown): string =>
  String(v ?? '')
    .replace(/\s+/g, '')
    .toLowerCase();

// ---------------------------------------------------------------------------
// 校验（两条路径共用）
// ---------------------------------------------------------------------------

export interface ValidateImportResult {
  /** 全部行（含不合格行） */
  rows: ProductImportRowResult[];
  issues: ProductImportIssue[];
  okCount: number;
  errorCount: number;
}

/**
 * 校验并规整一批行。
 *
 * `suppliers` 为空时**不做**「厂家对不上」的告警 —— 提交路径里厂家 id 已由界面下拉选定，
 * 此时供应商表为空（用户没启用采购域）不代表数据有问题。
 *
 * @param raw 待校验行（草稿形状即可）
 * @param suppliers 厂家参照表（名称 → id）
 */
export function validateImportRows(
  raw: ProductImportDraftRow[],
  suppliers: SupplierRef[],
): ValidateImportResult {
  const supplierByName = new Map<string, number>();
  for (const s of Array.isArray(suppliers) ? suppliers : []) {
    const key = normSupplierName(s?.name);
    if (key) supplierByName.set(key, Number(s?.id) || 0);
  }

  const rows: ProductImportRowResult[] = [];
  const issues: ProductImportIssue[] = [];
  const seenCode = new Map<string, number>();
  let okCount = 0;

  const list = Array.isArray(raw) ? raw : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] ?? {};
    const rowNo = Number(r.rowNo) || i + 1;
    const code = cell(r.code);
    const name = cell(r.name);
    const supplierRaw = cell(r.supplierRaw);
    const category = cell(r.category);
    const statusRaw = cell(r.status);
    const note = cell(r.note);

    // 先收集本行的两类消息，最后按 ok 决定并哪些 —— 不合格行不再叠 warning：
    // 那些行反正不入库，一堆"顺带提示"只会稀释真正的阻断原因。
    const errs: string[] = [];
    const warns: string[] = [];

    if (!code) {
      errs.push('款编码为空，该行跳过');
    } else if (code.length > MAX.code) {
      errs.push(`款编码超过 ${MAX.code} 字符，该行跳过`);
    } else {
      const dupAt = seenCode.get(code);
      if (dupAt !== undefined) {
        errs.push(`款编码与第 ${dupAt} 行重复，该行跳过（保留先出现的那行）`);
      } else {
        seenCode.set(code, rowNo);
      }
    }

    // 厂家：显式给了 id 就用它（提交路径）；否则按名称精确解析（解析路径）。
    // 只做「去空白 + 忽略大小写」的精确比对 —— 不去猜近似名。
    let supplierId = Number(r.supplierId) > 0 ? Math.floor(Number(r.supplierId)) : 0;
    if (!supplierId && supplierRaw && supplierByName.size > 0) {
      supplierId = supplierByName.get(normSupplierName(supplierRaw)) ?? 0;
      if (!supplierId) {
        warns.push(`厂家「${supplierRaw}」在供应商表里不存在，已按「未关联厂家」导入`);
      }
    }

    let status = 'active';
    if (statusRaw) {
      const parsed = parseStatusText(statusRaw);
      if (parsed) status = parsed;
      else warns.push(`状态「${statusRaw}」无法识别，已按「启用」导入`);
    }

    if (!name) warns.push('款式名为空，请导入后补充');

    const ok = errs.length === 0;
    for (const message of errs) issues.push({ rowNo, code, level: 'error', message });
    if (ok) {
      okCount++;
      for (const message of warns) issues.push({ rowNo, code, level: 'warning', message });
    }

    rows.push({
      rowNo,
      ok,
      code: code.slice(0, MAX.code),
      name: name.slice(0, MAX.name),
      supplierId,
      supplierRaw,
      category: category.slice(0, MAX.category),
      status,
      note: note.slice(0, MAX.note),
    });
  }

  return { rows, issues, okCount, errorCount: rows.length - okCount };
}

// ---------------------------------------------------------------------------
// 解析（Excel 路径）
// ---------------------------------------------------------------------------

/** 表头最多往下找几行（产品表首行常是标题横幅或填写说明） */
const HEADER_SCAN_ROWS = 10;

/**
 * 解析一张产品表（`rows` 为 `sheet_to_json({ header: 1, defval: '' })` 的二维数组）。
 *
 * @param rows2d 原始二维数组
 * @param suppliers 厂家参照表（名称 → id）；空数组表示没有任何厂家可关联
 * @returns `headerRow === -1` 表示该 sheet 不是产品表 —— 调用方应换下一张，
 *          **不要**回落成「取第一张」（那是「读错对象被伪装成对象有问题」的经典形态）。
 */
export function parseProductRows(
  rows2d: unknown[][],
  suppliers: SupplierRef[],
): ParseProductResult {
  const head = Array.isArray(rows2d) ? rows2d : [];
  let headerRow = -1;
  let columns: ProductImportColumns | null = null;
  for (let r = 0; r < Math.min(HEADER_SCAN_ROWS, head.length); r++) {
    const cols = resolveColumns(Array.isArray(head[r]) ? head[r] : []);
    // 必须同时认出编码列与名称列 —— 只认编码会把「编码说明」这类说明行当成表头
    if (cols.code !== -1 && cols.name !== -1) {
      headerRow = r;
      columns = cols;
      break;
    }
  }

  if (headerRow === -1 || !columns) {
    return {
      headerRow: -1,
      columns: { ...EMPTY_COLUMNS },
      headers: [],
      rows: [],
      issues: [],
      blankRows: 0,
    };
  }

  const cols = columns;
  const at = (row: unknown[], c: number): string => (c === -1 ? '' : cell(row[c]));

  const drafts: ProductImportDraftRow[] = [];
  let blankRows = 0;
  for (let r = headerRow + 1; r < head.length; r++) {
    const row = Array.isArray(head[r]) ? head[r] : [];
    const code = at(row, cols.code);
    const name = at(row, cols.name);
    const supplier = at(row, cols.supplier);
    const category = at(row, cols.category);
    const status = at(row, cols.status);
    const note = at(row, cols.note);

    if (!code && !name && !supplier && !category && !status && !note) {
      blankRows++;
      continue;
    }
    drafts.push({ rowNo: r + 1, code, name, supplierRaw: supplier, category, status, note });
  }

  const { rows, issues } = validateImportRows(drafts, suppliers);
  return {
    headerRow,
    columns: cols,
    headers: (head[headerRow] ?? []).map((h) => cell(h)),
    rows,
    issues,
    blankRows,
  };
}

// ---------------------------------------------------------------------------
// 导出（与导入同一份列名，保证「导出 → 改 → 导回」闭环）
// ---------------------------------------------------------------------------

/**
 * 导出/模板的表头（与 `COLUMN_FAMILIES` 精确档一致，故导出的文件能原样导回）。
 *
 * ⚠️ 第 3 列在 2026-10-01 由「厂家」改为「供应商」，与界面术语统一（页签名 / 指标条 / 表头列）。
 * 改它**不会**让老文件失效：`COLUMN_FAMILIES.supplier` 的别名同时收录「厂家名称 / 厂家 / 供应商名称 /
 * 供应商 / supplier」，所以用户手上按「厂家」表头导出的旧表仍能原样导回（见 `tests/productImport.spec.ts`
 * 的「导出的文件能原样导回」与 `HEAD = [... '厂家' ...]` 那条老表头夹具）。改这里前先跑那两条。
 */
export const PRODUCT_EXPORT_HEADERS = ['款编码', '款式名', '供应商', '类目', '状态', '备注'] as const;

export interface ProductExportRow {
  code: string;
  name: string;
  supplierName: string;
  category: string;
  status: string;
  note: string;
}

/**
 * 构造导出用的二维数组（首行表头）。
 * @param rows 产品行；`template` 为 true 时只出表头（「下载模板」）
 */
export function buildProductSheet(rows: ProductExportRow[], template = false): string[][] {
  const out: string[][] = [[...PRODUCT_EXPORT_HEADERS]];
  if (template) return out;
  for (const r of Array.isArray(rows) ? rows : []) {
    out.push([
      String(r?.code ?? ''),
      String(r?.name ?? ''),
      String(r?.supplierName ?? ''),
      String(r?.category ?? ''),
      // 导出成中文，与导入侧的中文映射对称；空值回落「启用」与库内默认一致
      String(r?.status ?? '') === 'archived' ? '停用' : '启用',
      String(r?.note ?? ''),
    ]);
  }
  return out;
}
