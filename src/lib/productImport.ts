// src/lib/productImport.ts
// 产品库 Excel 导入：解析 + 逐行校验（**纯函数**，宿主渲染层侧）。
//
// 为什么解析放这里而不是主进程 `electron/product-db.ts`：
//   ① 三层边界要求主进程不 import 渲染层代码（AGENTS.md §1.1）；
//   ② 口径只能有一份 —— 「哪列是编码」「厂家名怎么对 id」「状态怎么认」若再实现一遍，
//      两端口径必然漂移（与 shipping-rate 的归一化同一原则）；
//   ③ 纯函数可被 vitest 直接覆盖，而碰 SQLite 的那层测不了（better-sqlite3 是 Electron ABI）。
//
// 两条调用路径共用 `validateImportRows`：
//   · 首次导入：`parseProductRows`（列名匹配 → 校验）
//   · 失败行改完后重试：把行回传，只调 `validateImportRows`（不再做列名匹配）
// 两路共用同一个校验器是刻意的 —— 用户手改出来的「空编码」「重复编码」必须和 Excel 里的一样处理。
//
// ⚠️ 校验结果返回**全部行**（含不合格行，带 `ok` 标记），而不是只返回能入库的那些。
//    原因：P2 验收要求「10 行可在界面重试」—— 得先拿到那 10 行的原始值才能让用户改。
//    只回合格的会让"重试"变成一个不可能实现的按钮。
//
// 本文件**不做**厂家名的模糊匹配：对不上就报 warning 并落成 `supplier_id = 0`。
// 静默把「厂家甲」猜成「厂家乙」会把成本/对账挂到别人账上，且界面上看不出异常。
//
// ---------------------------------------------------------------------------
// 2026-10-08 列结构变更（用户拍板）：「类目」去掉，加「图片 / 颜色 / 尺码 / 克重」
// ---------------------------------------------------------------------------
// · **去掉「类目」**：模板与导出都不再有这一列，且**导入不再解析、不再提交**它。
//   配套改动在主进程：`importProducts` 对已存在的产品**显式保留** `category` ——
//   `upsertProduct` 是**全量提交**语义，少了这一列会把类目清空（"导出→改→导回"一次全灭，
//   而且不报错）。这是本轮最容易出数据事故的一处。
// · **「图片」列是占位列**：里面**不放文本**，图以 Excel 的**嵌入图片对象**浮在该列对应行上。
//   为什么不做「图片地址」文本列：用户要的是"在 Excel 里能看见图"，Excel 又**没有
//   "图片作为单元格内容"的存储格式**（除 Excel 365 的 `=IMAGE()`，兼容性差），所以只能走嵌入图。
//   嵌入图是**浮动对象**——它能被非 Excel 工具（含本仓的 SheetJS）直接忽略，
//   真正的读写都在主进程用 exceljs 做（`electron/xlsx-image.ts` / `product-extract-images`）。
//   ⇒ 本文件只负责**认出那一列**：里面若出现文字，给一条 warning 提醒"这版只认插进去的图"。
// · **颜色 / 尺码 / 克重**：一行仍然是**一个款**。
//   `颜色` 一格一个；`尺码` 与 `克重` 可以多值（逗号/顿号/分号分隔），**按顺序一一对应**
//   （`M,L,XL` ↔ `120,130,140`）。两列个数不等 ⇒ error（不猜、不对齐、不补零）。
//   为什么克重按顺序而不是"每个尺码配一格"：用户明确选了"克重导入后按尺码顺序对应"。
//   ⚠️ 顺序对应只可能活在**解析这一刻**（拿到的是两串原文），归一成 SKU 列表之后
//   这个下标语义就消失了 —— 所以它只在 `parseSkuCells` 里实现一次，提交路径不再重算。

/** 厂家的最小形状（id + 名称；来自 suppliers 表，由宿主注入） */
export interface SupplierRef {
  id: number;
  name: string;
}

/** 一个 SKU（归一后的形态） */
export interface ProductImportSku {
  color: string;
  size: string;
  /** 克重（克，整数）；0 = 未填 */
  weightG: number;
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
  status: string;
  note: string;
  /** 该行声明的 SKU（颜色 × 尺码，克重按顺序对应）；空数组 = 这行没说 SKU */
  skus: ProductImportSku[];
  /**
   * 该行的 SKU 单元格解析错误（尺码/克重个数对不上、克重不是整数…）。
   *
   * 单列出来而不是只留在 `issues` 里，是为了让**预览表**能分清"这行我在这儿能改"和
   * "这行得回 Excel 改"：预览表里能编辑的只有款编码/款式名，所以只要 `skuErrors` 非空，
   * 用户在当前界面就修不好它 —— 标成"待导入"是在骗人。
   */
  skuErrors: string[];
  /**
   * 已落盘并登记的产品主图（`pl_images.id`）；0 = 这行没有图。
   * 由主进程抽图那一步（`product-extract-images`）按**图的锚点行**回填 —— 解析侧产不出它。
   */
  imageId: number;
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
  image: number;
  color: number;
  size: number;
  weight: number;
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
  /** 全部数据行（含不合格行；已合并的同款行**不在**其中） */
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
 * 匹配顺序：先整列**精确**命中，再退到**包含**（长键优先）。
 *
 * ⚠️ 三条刻意的不收录（每条都有踩过的判据）：
 *   ① **不再有 `category`** —— 2026-10-08 起模板与导入都不带类目。老文件里的「类目」列
 *      现在**不匹配任何族**，于是被安全忽略（这正是"去列"想要的：不是报错，是当它不存在）。
 *   ② `size` **不收「规格」** —— 本仓「规格」指的是**整个 SKU**（颜色+尺码，见 UX-G1 术语表），
 *      收进来会把 `红-M` 这种整串当成"尺码"，然后与克重错位对应。
 *   ③ `weight` **不收「重」「净重」** —— 单字键在 `includes` 档会把「重量说明」这类列抢走。
 */
const COLUMN_FAMILIES = {
  code: ['款编码', '产品编码', '商品编码', '内部编码', '编码', 'code'],
  name: ['款式名', '产品名称', '商品名称', '款式名称', '品名', '名称', 'name'],
  supplier: ['厂家名称', '供应商名称', '厂家', '供应商', 'supplier'],
  image: ['图片地址', '产品图片', '图片', '主图', 'image'],
  color: ['颜色', '颜色分类', 'color'],
  size: ['尺码', '尺寸', '码数', 'size'],
  weight: ['克重', '单件克重', '重量', 'weightg', 'weight'],
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
  image: -1,
  color: -1,
  size: -1,
  weight: -1,
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

  const order: FamilyKey[] = [
    'code',
    'name',
    'supplier',
    'image',
    'color',
    'size',
    'weight',
    'status',
    'note',
  ];
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

const MAX = { code: 64, name: 200, note: 2000, sku: 40 } as const;

/** 待校验行的形状（Excel 路径由 `parseProductRows` 构造；提交路径由界面回传） */
export interface ProductImportDraftRow {
  rowNo?: unknown;
  code?: unknown;
  name?: unknown;
  supplierId?: unknown;
  supplierRaw?: unknown;
  status?: unknown;
  note?: unknown;
  /** 已归一的 SKU 列表（提交路径回传；解析路径由 `parseSkuCells` 产出） */
  skus?: unknown;
  /**
   * 该行**在进入校验器之前**就已发现的 error（目前唯一来源：SKU 单元格解析）。
   * 为什么要并进来而不是事后补 `ok=false`：合并逻辑只认合格行，事后补会让一个
   * "其实不合格"的行先被登记成合并目标，后续同款行就会并进一个不会入库的行里。
   */
  cellErrors?: unknown;
  /** 同上，warning 侧（如「图片」列里填了文字） */
  cellWarns?: unknown;
  /**
   * SKU 单元格错误（提交路径）——**二次校验必须同样认它**：
   * 提交时界面回传的是**行结果**（`skuErrors` 字段），不是解析中间态（`cellErrors`）；
   * 只认后者的话，预览里标了「跳过」的行会被二次校验原样放行（2026-10-09 实测：
   * 规格对不上的 IMP-3 带着空 SKU 提交落库）。两条路径进的是同一个校验器，字段就得都认。
   */
  skuErrors?: unknown;
  /** 该行要绑的主图 `pl_images.id`（抽图那步回填；0/缺省 = 没图） */
  imageId?: unknown;
}

/** 厂家名归一（比较用）：去空白 + 小写 */
const normSupplierName = (v: unknown): string =>
  String(v ?? '')
    .replace(/\s+/g, '')
    .toLowerCase();

// ---------------------------------------------------------------------------
// SKU 单元格解析（多值 + 顺序对应）—— 这条规则只在这里实现一次
// ---------------------------------------------------------------------------

/**
 * 多值分隔符。**不含空格与斜杠**：
 *   · 空格：`XL 加大` 是一个尺码，不是两个；
 *   · 斜杠：`M/L` 在服装里是"一个尺码的两种写法"，拆开反而制造两个不存在的尺码。
 */
const MULTI_SEP = /[,，、;；]/;

/** 拆多值：空单元格 → `[]`；分隔出的空片段**丢弃**（颜色/尺码里没有"没名字的那一个"） */
function splitMulti(v: unknown): string[] {
  const raw = String(v ?? '').trim();
  if (!raw) return [];
  return raw
    .split(MULTI_SEP)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * 拆克重：同样空单元格 → `[]`，但**保留空片段**。
 *
 * 为什么与 `splitMulti` 不同：克重列的空格位是**有意义的位置信息**。
 * 导出时"没填"写成空串（`''` 而不是 `0` —— 写 0 会让它在 Excel 里读作"称过，0 克"），
 * 于是一行两个尺码、只填了第二个的克重，导出就是 `,130`。若这里也过滤空片段，
 * 就只剩 `['130']` 一个值，与两个尺码**个数对不上** ⇒ 自己导出的文件自己导不回来。
 */
function splitWeightMulti(v: unknown): string[] {
  const raw = String(v ?? '').trim();
  if (!raw) return [];
  return raw.split(MULTI_SEP).map((s) => s.trim());
}

/**
 * 把「颜色 / 尺码 / 克重」三个单元格原文归成 SKU 列表。
 *
 * 规则（每条都对应一种"用户会怎么填"）：
 *   1. 颜色**只允许一个**（要多个颜色就分多行写 —— 模板的约定是"一行一个款"）；
 *   2. 尺码与克重都可多值，**按顺序一一对应**；个数不等 ⇒ error（不猜、不补零、不循环）；
 *   3. 整行没填尺码也没填克重 ⇒ 这个行**不声明 SKU**（只导产品本身），不是错误；
 *   4. 只填克重不填尺码 ⇒ error —— 克重没有可归属的 SKU；
 *   5. 填了尺码就必须填颜色 —— `variantUpsert` 的硬约束是"颜色与尺码成对"
 *      （否则只能退化成老数据的"自由名称"形态，界面会把它标成「旧 SKU」，
 *      那是把一份新数据伪装成历史数据）；
 *   6. 克重：允许 `120` / `120g` / `120 克`（剥单位，无歧义），必须是不小于 0 的整数；
 *      `120.5` 这类直接 error（不四舍五入 —— 静默改数字比报错难查得多）。
 *
 * @returns `skus` 为空且 `errors` 为空 = 这行不声明 SKU
 */
export function parseSkuCells(
  colorRaw: unknown,
  sizeRaw: unknown,
  weightRaw: unknown,
): { skus: ProductImportSku[]; errors: string[] } {
  const errors: string[] = [];
  const colors = splitMulti(colorRaw);
  const sizes = splitMulti(sizeRaw);
  const weights = splitWeightMulti(weightRaw);

  if (colors.length > 1) {
    return { skus: [], errors: [`颜色只支持一个（要多个颜色请分多行写）：「${colors.join('、')}」`] };
  }
  const color = colors[0] ?? '';
  if (color.length > MAX.sku) {
    return { skus: [], errors: [`颜色超过 ${MAX.sku} 字符，该行跳过`] };
  }

  if (!sizes.length) {
    if (weights.length) {
      return { skus: [], errors: ['填了克重却没填尺码 —— 不知道这个克重写给哪个 SKU'] };
    }
    return { skus: [], errors: [] };
  }

  if (!color) {
    return { skus: [], errors: ['填了尺码就要填颜色（颜色与尺码成对填写）'] };
  }
  if (weights.length && weights.length !== sizes.length) {
    return {
      skus: [],
      errors: [
        `尺码 ${sizes.length} 个、克重 ${weights.length} 个，对不上 —— 两列要按顺序一一对应（每个尺码都要写一格，都一样也要写满）`,
      ],
    };
  }

  const skus: ProductImportSku[] = [];
  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i];
    if (size.length > MAX.sku) {
      errors.push(`第 ${i + 1} 个尺码超过 ${MAX.sku} 字符：「${size}」`);
      continue;
    }
    let weightG = 0;
    if (weights.length) {
      const raw = weights[i];
      // 剥单位：`120g` / `120 克` / `120克` 都当 120 —— 这是"同一个数的不同写法"，不是猜意图
      const n = Number(raw.replace(/[gGｇ]|克/g, '').trim());
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        errors.push(`克重「${raw}」不是不小于 0 的整数（克）`);
        continue;
      }
      weightG = n;
    }
    skus.push({ color, size, weightG });
  }
  return { skus, errors };
}

/**
 * SKU 列表的**防御性**归一（提交路径）。只做形状消毒，不做业务判定 ——
 * 业务判定（顺序对应 / 成对 / 格式）已经在 `parseSkuCells` 那一遍做完了，
 * 而且那一条规则的**下标语义天然只属于解析那一刻**（归一后两串原文就不存在了）。
 */
function sanitizeSkus(v: unknown): ProductImportSku[] {
  if (!Array.isArray(v)) return [];
  const out: ProductImportSku[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const color = cell(r.color).slice(0, MAX.sku);
    const size = cell(r.size).slice(0, MAX.sku);
    const n = Number(r.weightG);
    out.push({ color, size, weightG: Number.isFinite(n) && n > 0 ? Math.round(n) : 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 校验（两条路径共用）
// ---------------------------------------------------------------------------

export interface ValidateImportResult {
  /** 全部行（含不合格行；已合并的同款行**不在**其中） */
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
 * **同款多行 = 合并**（2026-10-08 起，取代原来的"重复即报错剔行"）：
 * 模板的约定是"一行一个款"，但同一个款分几行写（每行一个颜色是最自然的用法）不该算错误。
 * 合并规则：SKU 相加（同 颜色+尺码 去重，先出现者胜）；产品字段（款式名/厂家/状态/备注）
 * **取先出现的那行的非空值**，不一致时给 warning。被并入的那一行**从结果里消失**
 * （它不是"不合格"，而是"已经并到别处了"，留在列表里只会让人以为要改两遍）。
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
  /** 编码 → rows 里的下标（只登记**合格**行） */
  const byCode = new Map<string, number>();
  /** 每个已登记款的 SKU 去重键集合 */
  const skuKeys = new Map<string, Set<string>>();
  let okCount = 0;

  const skuKeyOf = (s: ProductImportSku): string => `${s.color}\u0000${s.size}`;

  const list = Array.isArray(raw) ? raw : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] ?? {};
    const rowNo = Number(r.rowNo) || i + 1;
    const code = cell(r.code);
    const name = cell(r.name);
    const supplierRaw = cell(r.supplierRaw);
    const statusRaw = cell(r.status);
    const note = cell(r.note);
    const skus = sanitizeSkus(r.skus);

    // 先收集本行的两类消息，最后按 ok 决定并哪些 —— 不合格行不再叠 warning：
    // 那些行反正不入库，一堆"顺带提示"只会稀释真正的阻断原因。
    // `skuErrors` 单独留一份（不是从 errs 里过滤出来的）：它是"回 Excel 才能改"的那一类，
    // 预览表要靠它决定这行标不标"待导入"。
    // ⚠️ 两个来源都要认：解析路径给 `cellErrors`，提交路径回传的行结果给 `skuErrors` ——
    //    只认一个，另一条路径上这行就会"看着标了跳过、其实照样提交"（实测踩过）。
    const skuErrors: string[] = [
      ...(Array.isArray(r.cellErrors) ? r.cellErrors : []),
      ...(Array.isArray(r.skuErrors) ? r.skuErrors : []),
    ].map((x) => cell(x));
    const errs: string[] = [...skuErrors];
    const warns: string[] = Array.isArray(r.cellWarns) ? r.cellWarns.map((x) => cell(x)) : [];

    if (!code) {
      errs.push('款编码为空，该行跳过');
    } else if (code.length > MAX.code) {
      errs.push(`款编码超过 ${MAX.code} 字符，该行跳过`);
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

    // ---- 同款合并：把这一行的 SKU 并进先出现的那一行 ----
    if (ok && code) {
      const at = byCode.get(code);
      if (at !== undefined) {
        const target = rows[at];
        const seen = skuKeys.get(code) ?? new Set<string>();
        for (const s of skus) {
          const k = skuKeyOf(s);
          if (seen.has(k)) {
            issues.push({
              rowNo: target.rowNo,
              code,
              level: 'warning',
              message: `第 ${rowNo} 行又写了一遍「${[s.color, s.size].filter(Boolean).join(' ')}」，已按先出现的那个克重保留`,
            });
            continue;
          }
          seen.add(k);
          target.skus.push(s);
        }
        skuKeys.set(code, seen);
        if (name && target.name && name !== target.name) {
          issues.push({
            rowNo: target.rowNo,
            code,
            level: 'warning',
            message: `第 ${rowNo} 行的款式名是「${name}」，与先出现的那行不一致，已保留「${target.name}」`,
          });
        } else if (name && !target.name) {
          target.name = name;
        }
        // ⚠️ 合并**成功**（没丢任何信息）时不发 warning：导出时一个款会按颜色拆成多行，
        //    导回来必然走这条合并分支 —— 每次都报一条"已并入"就变成纯噪音，
        //    而用户"只看有问题"时会被这些噪音灌满。只有**真丢了东西**（重复的 SKU、
        //    冲突的款式名）才值得说一句。
        continue;
      }
    }

    for (const message of errs) issues.push({ rowNo, code, level: 'error', message });
    if (ok) {
      okCount++;
      for (const message of warns) issues.push({ rowNo, code, level: 'warning', message });
      if (code) {
        byCode.set(code, rows.length);
        skuKeys.set(code, new Set(skus.map(skuKeyOf)));
      }
    }

    rows.push({
      rowNo,
      ok,
      code: code.slice(0, MAX.code),
      name: name.slice(0, MAX.name),
      supplierId,
      supplierRaw,
      status,
      note: note.slice(0, MAX.note),
      skus,
      skuErrors,
      // 抽图那步（主进程）算出来的图 id；解析路径进来时恒 0，由 `productIo` 回填后
      // **再走一遍**同一套提交校验 —— 所以这里必须做同样的防御性规整，不能只透传。
      imageId: toPositiveInt(r.imageId),
    });
  }

  return { rows, issues, okCount, errorCount: rows.length - okCount };
}

/** 正整数（图片 id / 行号一类）；非法 → 0（"没有"而不是"用了个错的"） */
function toPositiveInt(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : 0;
}

// ---------------------------------------------------------------------------
// 嵌入图归位（主进程抽图 → 贴回解析结果）
// ---------------------------------------------------------------------------

/** 主进程抽到的一张图（已落盘 + 登记 `pl_images`） */
export interface ExtractedImageInfo {
  imageId: number;
  /** 落盘后的绝对路径（界面要看的就是"图真的进来了没有"） */
  localPath: string;
}

/** 抽图时判为"不能归位"的图（按锚点行报，不静默丢） */
export interface ExtractedImageSkip {
  /** 锚点所在行（1-based Excel 行号） */
  rowNo: number;
  reason: string;
}

/**
 * 把抽出的一批图按**锚点行号**贴回解析结果。
 *
 * 为什么必须按行号而不是按顺序：Excel 的嵌入图是**浮动对象**，与行没有结构上的绑定 ——
 * 用户在上面插一行、删一行，图会跟着漂，或者干脆停在一个没有数据的行上。
 * 顺序法（第 1 张图配第 1 行）会把这些错位**全部吃掉并且不报错**，最后表现为
 * "图进了系统但配错了款"，比直接丢图难查得多。所以这里只认行号，认不出来就报。
 *
 * @param rows 解析结果（不改）
 * @param byRow 行号（字符串键，IPC 序列化的 Map）→ 图
 * @param skips 主进程报的"没能归位"明细（落到非数据行、一行多图…）
 */
export function attachExtractedImages(
  rows: ProductImportRowResult[],
  byRow: Record<string, ExtractedImageInfo> | null | undefined,
  skips: ExtractedImageSkip[] | null | undefined,
): { rows: ProductImportRowResult[]; issues: ProductImportIssue[] } {
  const map = new Map<number, ExtractedImageInfo>();
  for (const [k, v] of Object.entries(byRow ?? {})) {
    const rowNo = Number(k);
    const imageId = Number(v?.imageId);
    if (Number.isInteger(rowNo) && rowNo > 0 && Number.isInteger(imageId) && imageId > 0) {
      map.set(rowNo, { imageId, localPath: String(v?.localPath ?? '') });
    }
  }

  const issues: ProductImportIssue[] = [];
  const out = (Array.isArray(rows) ? rows : []).map((r) => {
    const hit = map.get(r.rowNo);
    if (!hit) return r;
    // ⚠️ 图**不改变**行的合格性：`ok` 由字段校验决定。给一个字段有问题、本来要跳过的行
    //    贴上图，只是让它下次导进来时带上图，不该把它从"跳过"变成"入库"。
    return { ...r, imageId: hit.imageId };
  });

  const known = new Set(out.map((r) => r.rowNo));
  for (const [rowNo, hit] of map) {
    if (known.has(rowNo)) continue;
    // 走到这里 = 抽图报了行号，但解析结果里没有这一行。三种可能：表头以上的行、
    // 整行为空被跳过的行、以及**与上一行同款被合并掉的行**。三条都要说，不能只说第一条。
    issues.push({
      rowNo,
      code: '',
      level: 'warning',
      message: `第 ${rowNo} 行插了图片，但那一行没有对应的导入行（表头以上 / 空行 / 与上一行同款已合并），这张图没有归位`,
    });
  }
  for (const s of Array.isArray(skips) ? skips : []) {
    const rowNo = Number(s?.rowNo) || 0;
    const code = out.find((r) => r.rowNo === rowNo)?.code ?? '';
    issues.push({ rowNo, code, level: 'warning', message: String(s?.reason ?? '这张图没能归位') });
  }

  return { rows: out, issues };
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
    const imageText = at(row, cols.image);
    const color = at(row, cols.color);
    const size = at(row, cols.size);
    const weight = at(row, cols.weight);
    const status = at(row, cols.status);
    const note = at(row, cols.note);

    // 「图片」列**不参与**"整行为空"的判断：只写了一个图片地址、其余全空的行是残留，
    // 不该变成一条"款编码为空"的红色错误行。它对应的图由抽图那一步报"落在非数据行"。
    if (!code && !name && !supplier && !color && !size && !weight && !status && !note) {
      blankRows++;
      continue;
    }

    const rowNo = r + 1;
    const parsed = parseSkuCells(color, size, weight);

    const cellWarns: string[] = [];
    if (imageText) {
      cellWarns.push(
        '「图片」列里填的是文字 —— 这一版只认插进表格里的图片（在那一格里插入图片），文字地址会被忽略',
      );
    }

    drafts.push({
      rowNo,
      code,
      name,
      supplierRaw: supplier,
      status,
      note,
      skus: parsed.skus,
      cellErrors: parsed.errors,
      cellWarns,
    });
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
 * 导出/模板的表头（与 `COLUMN_FAMILIES` 的精确档一致，故导出的文件能原样导回）。
 *
 * ⚠️ 两处历史坐标，改这里前先读：
 *   · 第 3 列 2026-10-01 由「厂家」改为「供应商」（界面术语统一）。改它**不会**让老文件失效：
 *     `COLUMN_FAMILIES.supplier` 同时收录「厂家名称 / 厂家 / 供应商名称 / 供应商 / supplier」，
 *     用户手上按「厂家」表头导出的旧表仍能原样导回。
 *   · 2026-10-08：**去掉「类目」**，加「图片 / 颜色 / 尺码 / 克重」。老文件里的「类目」列
 *     不匹配任何族 ⇒ 被安全忽略（导入不再覆盖类目，见文件头）。
 */
export const PRODUCT_EXPORT_HEADERS = [
  '款编码',
  '款式名',
  '供应商',
  '图片',
  '颜色',
  '尺码',
  '克重',
  '状态',
  '备注',
] as const;

/** 导出时用的 SKU 形状（与 `ProductImportSku` 同构，分开命名是为了各自演进不互相牵动） */
export interface ProductExportSku {
  color: string;
  size: string;
  weightG: number;
}

export interface ProductExportRow {
  code: string;
  name: string;
  supplierName: string;
  /** 主图本地缓存路径（'' = 无图）。图由主进程按这个路径嵌进「图片」列 */
  imagePath: string;
  status: string;
  note: string;
  /** 该款的 SKU（导出时按颜色分组拆行） */
  skus: ProductExportSku[];
}

/** 一条输出行 + 它的"归属"（图的锚点按它定位） */
export interface ProductExportLayoutRow {
  cells: string[];
  /** 这条输出行属于哪个款 */
  code: string;
  /** 是不是该款的**第一条**输出行（图只嵌这里 —— 否则多颜色的款会把同一张图嵌 N 遍） */
  firstOfCode: boolean;
  /** 要嵌的图（仅 `firstOfCode` 时非空） */
  imagePath: string;
}

/**
 * 构造导出行的**布局**（首行表头 + 每个款按颜色分组的输出行）。
 *
 * 为什么按颜色拆行：导入侧的颜色**一格只能一个**（见 `parseSkuCells` 规则 1）。
 * 一个款若有 2 个颜色 × 3 个尺码而导出压成一行，那这一行就**导不回来**
 * （颜色那一格变成 `红,蓝`，导入会直接报 error）—— 闭环会断在导出这一步。
 * 拆行之后，`尺码`/`克重` 两列在一行内仍是"顺序对应"的同一套规则，导回无损。
 *
 * @param rows 产品行；`template` 为 true 时只出表头（「下载模板」）
 */
export function buildProductSheetLayout(
  rows: ProductExportRow[],
  template = false,
): ProductExportLayoutRow[] {
  const head: ProductExportLayoutRow = {
    cells: [...PRODUCT_EXPORT_HEADERS],
    code: '',
    firstOfCode: false,
    imagePath: '',
  };
  if (template) return [head];

  const out: ProductExportLayoutRow[] = [head];
  for (const r of Array.isArray(rows) ? rows : []) {
    const code = String(r?.code ?? '');
    const name = String(r?.name ?? '');
    const supplier = String(r?.supplierName ?? '');
    // 导出成中文，与导入侧的中文映射对称；空值回落「启用」与库内默认一致
    const status = String(r?.status ?? '') === 'archived' ? '停用' : '启用';
    const note = String(r?.note ?? '');
    const imagePath = String(r?.imagePath ?? '');

    const skus = (Array.isArray(r?.skus) ? r.skus : []).filter(
      (s) => String(s?.color ?? '') || String(s?.size ?? ''),
    );

    if (!skus.length) {
      out.push({
        cells: [code, name, supplier, '', '', '', '', status, note],
        code,
        firstOfCode: true,
        imagePath,
      });
      continue;
    }

    // 按颜色分组（保持各颜色首次出现的顺序 —— 导出结果要可复现）
    const order: string[] = [];
    const groups = new Map<string, ProductExportSku[]>();
    for (const s of skus) {
      const color = String(s?.color ?? '');
      if (!groups.has(color)) {
        groups.set(color, []);
        order.push(color);
      }
      groups.get(color)!.push({
        color,
        size: String(s?.size ?? ''),
        weightG: Number(s?.weightG) > 0 ? Math.round(Number(s.weightG)) : 0,
      });
    }

    order.forEach((color, i) => {
      const g = groups.get(color)!;
      out.push({
        cells: [
          code,
          name,
          supplier,
          '',
          color,
          g.map((x) => x.size).join(','),
          // 未填克重（0）导成空串：0 与"没填"是两回事，写 0 会让下一次导入把 0 当成一个数值
          g.map((x) => (x.weightG > 0 ? String(x.weightG) : '')).join(','),
          status,
          note,
        ],
        code,
        firstOfCode: i === 0,
        imagePath: i === 0 ? imagePath : '',
      });
    });
  }
  return out;
}

/**
 * 构造导出用的二维数组（首行表头）。
 * @param rows 产品行；`template` 为 true 时只出表头（「下载模板」）
 */
export function buildProductSheet(rows: ProductExportRow[], template = false): string[][] {
  return buildProductSheetLayout(rows, template).map((r) => r.cells);
}
