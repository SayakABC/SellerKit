// src/lib/shipRate.ts
// 「无忧物流运费」业务域的纯函数层：物流报价单 Excel → 归一化运价表 → 按克重计价。
//
// 为什么独立成文件（而不是写在 host.ts 里）：
//   ① 报价单不是二维表 —— 一张 sheet 上拼了 17 段**列结构互不相同**的价卡（见
//      docs/archive/plans/SHIPPING_RATE_ISLAND_PLAN.md §1），归一化是纯数组处理，与 IPC / axios 无关；
//   ② 独立后可被 vitest 直接覆盖（tests/shipRate.spec.ts 用真实 Excel 的夹具断言），
//      不必 mock 整个宿主能力面 —— 与 sanitizeExcel.ts / payloadBudget.ts 同构；
//   ③ 岛运行在 iframe 内（不打包 xlsx、CSP 无 unsafe-eval），"读表"与"算费"都必须留在宿主；
//      两者收在同一文件，是保证口径不两地漂移的最省事做法。
//
// ⚠️ 版式不是一种，是一族（2026-09-25 实测源工作簿的 21 张 sheet）：
//   ① **3 行表头**（类别 / 档位 / 叶子）—— 无忧物流-标准、特惠、优先、三方清关…
//   ② **2 行表头**（档位在表头行、叶子在下一行，**无类别标题**）—— 燕文航空挂号小包、
//      超级经济全系列、顺友、威海优选仓、陆运大件…
//   ③ **2 行表头但上下颠倒**（叶子在上、档位在下）—— 无忧物流-特货标准、特货标快
//   ④ **1 行表头**（只有叶子，档位/限重写在叶子里）—— 4PX新邮挂号小包、超级经济（部分）
//   ⑤ 分档行式宽表 / A 列不是「运达国家/地区」—— 海运大件专线、超大件专线，**不在本文件能力内**
//   所以表头行数与**上下顺序**都必须**探测**，不能靠 `hdr+1` / `hdr+2` 这种固定偏移。

/** 计价模式：按 KG 费率 + 挂号费，或 首重 + 续重 */
export type ChargeMode = 'perKg' | 'firstStep';

/**
 * 计费类别：普货小包 / 非普货小包 / 大包 / 不分品类。
 *
 * `any` = 该价卡所属的表**整个不分品类**（燕文、4PX、超级经济这类单一价线路）。
 * 刻意不复用 `general`：那会在界面上把"不分品类"谎称成"普货"，而两者在
 * 强制类别查询时的语义并不相同（普货查询会命中 general，但不该因此宣称该表是普货价）。
 */
export type Category = 'general' | 'special' | 'bulk' | 'any';

/** 取整口径：四舍五入到分 / 向上进位到分 */
export type Rounding = 'round' | 'ceil';

/**
 * 报价币种。表头文本里写死的（`元（RMB）/KG` / `美元（USD）/KG`）；空串 = 表里没标注。
 *
 * ⚠️ 为什么要单独建模：`无忧物流-特惠` 与 `超级经济` 系列的表头写的是**美元**，
 * 而本域的历史口径一律按人民币。若不识别币种，切到这两张表就会把美元价当人民币算 ——
 * 金额差 7 倍且**不报任何错**。见 shipRateQuote.ts 的 `QUOTE_CURRENCY`。
 */
export type Currency = 'CNY' | 'USD' | '';

/** 小包与自动判定大包的分界克重（报价单口径：申报或实际 >2kg 即为大包） */
export const SMALL_MAX_G = 2000;
/** 大包限重（报价单多处标注「限重30kg」） */
export const BULK_MAX_G = 30000;
/** 首重克数 / 续重步长（报价单统一为 0.5KG 首重、每 500G 续重） */
export const BASE_G = 500;
export const STEP_G = 500;

/** 一张价卡：某个分节里、某个类别、某个重量档的计价规则 */
export interface RateCard {
  /** 分节序号（1-based），便于排查"这条价来自表里哪一块" */
  sec: number;
  /** 适用类别。分节 5（韩国）一个价同时适用普货与非普货，故为集合 */
  categories: Category[];
  /** 非普货的仓库变体（其他仓 / 香港仓）；无变体时空串 */
  variant: string;
  /** 档位下界（含），单位克 */
  minG: number;
  /** 档位上界（含），单位克 */
  maxG: number;
  mode: ChargeMode;
  /** perKg：配送服务费 元/KG（每 1g 计重） */
  ratePerKg: number;
  /** perKg：挂号服务费 元/包裹 */
  registerFee: number;
  /** firstStep：0.5KG 首重 元/包裹 */
  firstFee: number;
  /** firstStep：续重 元/500G */
  stepFee: number;
  baseG: number;
  stepG: number;
  /** 报价币种（取自该价卡的叶子表头文本）；空串 = 表里没写 */
  currency: Currency;
  /**
   * 最低计费重量（克）。报价单里单列「最低计费重量 10g」/「起重 克」，
   * 不足此重量按此重量计重 —— 不套用会少算一笔（金额小但口径错）。
   * 0 = 该节没有这个约束。
   */
  minChargeG: number;
}

/** 一个目的地的全部价卡 */
export interface CountryRate {
  /** ISO 二字码（表内 Code 列），可能为空串 */
  code: string;
  nameCn: string;
  nameEn: string;
  cards: RateCard[];
}

/** 分节摘要（运价表页展示用） */
export interface RateSection {
  sec: number;
  headerRow: number;
  countryCount: number;
  categories: Category[];
  /** 该节价卡的币种（多数派；空串 = 未标注）—— 界面据此提示"切到这张表会换币种" */
  currency: Currency;
  /** 该节的最低计费重量（克；0 = 无此约束） */
  minChargeG: number;
}

export interface RateTableStats {
  sections: number;
  countries: number;
  cards: number;
  perKgCards: number;
  firstStepCards: number;
  /** 整表出现过的币种（去重、按出现顺序） */
  currencies: Currency[];
}

/** 归一化后的运价表（落岛存储 / 传给计价 op 的实体） */
export interface RateTable {
  sheetName: string;
  countries: CountryRate[];
  sections: RateSection[];
  stats: RateTableStats;
  warnings: string[];
}

// ─────────────────────────────────────────────────────────── 文本 / 数值解析

const cellText = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/**
 * 取单元格数值；空 / 非数 → null。
 * 刻意区分「缺失」（null）与「真的是 0」——前者要报 warning（否则会静默少算一笔挂号费）。
 */
function cellNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = cellText(v).replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 档位文本解析结果；某一侧为 null = 该侧没写 */
interface GramRange {
  minG: number | null;
  maxG: number | null;
}

/**
 * 重量档位文本 → 克区间。表内格式并不统一，四种都要认：
 *   `0~150g(含)` / `0-2100g（含）` / `2100-30000g`   两个数 = 上下界
 *   `2KG以内（包含2KG）`                              两数相同 = **只说上限**（下界为 0）
 *   `限重30kg` / `限制2KG`                            单数 + 限重/以内 = 上限
 *   `>1000g` / `1000g以上`                            单数 + 大于/以上 = 下界
 *
 * ⚠️ 单位必须按整段文本判（kg 还是 g），不能只看数字：
 * `2KG以内（包含2KG）` 若不换单位会得到 `[2, 2]` 克 —— 一张只覆盖 2 克的价卡，
 * 界面上看不出异常，只是所有 >2g 的查询都报"无可用运价"。
 * ⚠️ 单个裸数字（如矩阵表列头的 `31KG`）语义不明 → 返回 null，不猜。
 */
function parseZoneRange(text: string): GramRange | null {
  const nums = text.match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return null;
  const unit = /kg|公斤/i.test(text) ? 1000 : 1;
  const scaled = nums.map((n) => Number(n) * unit);
  if (scaled.some((n) => !Number.isFinite(n))) return null;

  if (scaled.length >= 2) {
    const [a, b] = scaled;
    if (a === b) return { minG: null, maxG: b };
    return b < a ? null : { minG: a, maxG: b };
  }

  const v = scaled[0];
  if (/(?:>|≥|大于)/.test(text) || /以上/.test(text)) return { minG: v, maxG: null };
  if (/以内|以下|限重|不超过/.test(text)) return { minG: null, maxG: v };
  return null;
}

/** 类别标题里的「限重30kg」→ 克；无命中返回 null */
function parseLimitG(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:kg|公斤)/i);
  if (!m) return null;
  const kg = Number(m[1]);
  return Number.isFinite(kg) && kg > 0 ? Math.round(kg * 1000) : null;
}

/** `10g` / `1` / `0.5kg` → 克；无数字返回 null（最低计费重量列用） */
function parseGramValue(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(kg|公斤|g|克)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /kg|公斤/i.test(m[2] ?? '') ? Math.round(n * 1000) : Math.round(n);
}

/**
 * 叶子表头文本 → 币种。
 *
 * ⚠️ 必须先判「美元」再判「元」：`美元（USD）/KG` 同时含这两个字，
 * 顺序反了会把美元价当人民币（本域历史上就按人民币算，等于静默错 7 倍）。
 */
function parseCurrency(text: string): Currency {
  if (/美元|USD|\$/i.test(text)) return 'USD';
  if (/RMB|CNY|人民币|元/i.test(text)) return 'CNY';
  return '';
}

/**
 * 类别标题 → 类别集合。
 *
 * ⚠️ 必须先剔除「非普货」再找「普货」：`小包非普货计费` 同时含这两个子串，
 * 直接 includes('普货') 会让非普货价卡被算成普货价（结果偏小且不报错）。
 * 分节 5 的 `小包普货&小包非普货计费` 剔完后还剩「普货」→ 正确地得到两个类别。
 *
 * ⚠️ 「大小包」要排除：海运大件专线的列名是「大小包」（= 小包与大包都适用）。
 * 不排除就会因含「大包」被判成 `bulk`，把整节价卡错标成"只适用大包"。
 */
function parseCategories(title: string): Category[] {
  if (/(?<!小)大包/.test(title)) return ['bulk'];
  const out: Category[] = [];
  if (title.replace(/非普货/g, '').includes('普货')) out.push('general');
  if (title.includes('非普货')) out.push('special');
  return out;
}

/** 类别标题里的仓库变体（`（其他仓）` → 其他仓）；`计泡` 是属性不是变体，剔除 */
function parseVariant(title: string): string {
  const m = title.match(/[（(]([^）)]*)[）)]/);
  if (!m) return '';
  const v = m[1].trim();
  return v === '计泡' ? '' : v;
}

type LeafKind = 'delivery' | 'register' | 'first' | 'step' | 'minCharge';

/**
 * 「不提供该服务」的显式标记。
 * 报价单里不支持的类别**不是留空**，而是写「暂无服务」（分节 1 有 101 处）。
 * 若把它当成"数值异常"，warning 会被这 101 条淹没，真异常反而看不见。
 */
const NOT_OFFERED_RE = /暂无|无服务|^\s*[-—–/]+\s*$/;

/**
 * 叶子表头文本 → 语义。
 *
 * 同义词是必需品，不是锦上添花：同一条线路的不同承运商写法不同 ——
 * `挂号服务费`（无忧物流）/ `Item 服务费`（燕文、超级经济、顺友，实测 6 张表）/
 * `操作处理费`（中邮e邮宝）。漏一个就等于那半张表的费用**整列丢失**，
 * 而界面上仍会给出一个偏小的金额（不会报错）。
 */
function leafKind(text: string): LeafKind | null {
  if (text.includes('配送服务费') || text.includes('重量资费')) return 'delivery';
  if (text.includes('挂号服务费') || text.includes('Item 服务费')) return 'register';
  if (text.includes('操作处理费') || text.includes('处理费')) return 'register';
  if (text.includes('最低计费重量') || text.includes('起重')) return 'minCharge';
  if (text.includes('首重')) return 'first';
  if (text.includes('续重')) return 'step';
  return null;
}

// ─────────────────────────────────────────────────────────── 归一化

/** 节头标识：每段价卡的 A 列都是这几个字（个别线路写作「国家/地区列表」） */
const HEADER_LABEL = '运达国家/地区';
/** A 列是否为分节表头。用「包含」而非「开头」：源表里有 `国家/地区列表` 这种变体 */
const SECTION_HEADER_RE = /(?:运达|目的地)[^a-zA-Z]*国家\s*\/\s*地区|^国家\s*\/\s*地区/;
/** 前 3 列固定为：A 国家中文 / B 国家英文 / C Code，价卡列从 D（下标 3）开始 */
const FIRST_DATA_COL = 3;
/** 表头行角色探测的扫描窗口（hdr 之后最多看几行；实测最多 3 行表头） */
const LAYOUT_SCAN_ROWS = 5;

/** A 列是否是分节表头 */
const isSectionHeader = (text: string): boolean => SECTION_HEADER_RE.test(text.trim());

/** 一个有效列解析出的上下文 */
interface ColumnContext {
  groupStart: number;
  zoneText: string;
  categories: Category[];
  variant: string;
  minG: number;
  maxG: number;
  currency: Currency;
}

/** 价卡模板：只有列号与档位，数值留到逐行取（同一节内各国共用一张模板） */
interface CardTemplate extends ColumnContext {
  mode: ChargeMode;
  /** perKg 用 */
  rateCol: number;
  registerCol: number;
  /** firstStep 用 */
  firstCol: number;
  stepCol: number;
}

/**
 * 表头**行角色**（探测结果）。行号都是 `rows` 数组下标，-1 = 该角色不存在。
 *
 * 为什么不写死 `hdr / hdr+1 / hdr+2`：实测 21 张 sheet 里表头有 1~3 行，
 * 且叶子行与档位行的**上下顺序会颠倒**（无忧物流-特货标准 / 特货标快是"叶子在上、档位在下"）。
 * 固定偏移的写法在这类表上会把**数据行当成叶子行**，报出「表头结构无法识别」——
 * 文案指向"数据有问题"，真实原因是版式族没覆盖到。
 */
interface HeaderLayout {
  /** 类别行（含「小包普货计费」等）；无类别标题的表为 -1 */
  catRow: number;
  /** 档位行（含「0~150g(含)」等）；无档位为 -1 */
  zoneRow: number;
  /** 叶子语义行（含「配送服务费」等）；必存在，否则整节跳过 */
  leafRow: number;
}

/**
 * 探测本节的表头行角色。
 *
 * 规则：在 `[hdr, end)` 内扫描（最多 LAYOUT_SCAN_ROWS 行，**遇到 A 列非空的行即停** ——
 * 那要么是下一节表头、要么是数据行），分别统计每行的叶子语义列数 / 档位列数 / 类别命中数：
 *   · leafRow = 叶子语义列最多的那一行（必须 > 0）；
 *   · zoneRow = 档位列最多的那一行，**排除 leafRow 自身** ——
 *     否则 `起重 克`、`*每1g计重，限重2KG` 这类含数字的**叶子**文本会被误当档位，
 *     把真正的档位（如 `0~150g(含)`）挤掉；
 *   · catRow  = 首个出现类别标题的行（通常就是 hdr 行）。
 */
function detectLayout(data: unknown[][], hdr: number, end: number): HeaderLayout | null {
  let leafRow = -1;
  let leafHits = 0;
  let zoneRow = -1;
  let zoneHits = 0;
  let catRow = -1;
  const stop = Math.min(hdr + LAYOUT_SCAN_ROWS, end);

  for (let r = hdr; r < stop; r++) {
    const row = data[r] ?? [];
    // A 列非空 = 下一节表头或数据行，表头扫描到此为止（hdr 行本身例外）
    if (r > hdr && cellText(row[0])) break;
    let leaf = 0;
    let zone = 0;
    let cat = 0;
    for (let c = FIRST_DATA_COL; c < row.length; c++) {
      const t = cellText(row[c]);
      if (!t) continue;
      // ⚠️ 「最低计费重量」列**不算叶子命中**：它是整节的列属性，常与档位同处表头行。
      //    算进去会让表头行被当成叶子行，于是真正的档位行被排除在候选之外，
      //    整节的档位全部丢失（超级经济-燕文 就是这么从 [0,100]/[101,2000] 退化成 [0,30000] 的）。
      const k = leafKind(t);
      if (k && k !== 'minCharge') leaf++;
      if (parseZoneRange(t)) zone++;
      if (parseCategories(t).length) cat++;
    }
    if (leaf > leafHits) {
      leafHits = leaf;
      leafRow = r;
    }
    if (r !== leafRow && zone > zoneHits) {
      zoneHits = zone;
      zoneRow = r;
    }
    if (cat > 0 && catRow < 0) catRow = r;
  }

  if (leafRow < 0) return null;
  return { catRow, zoneRow, leafRow };
}

/**
 * 定位某列的上下文：向左回溯找「类别起点」与「重量档」。
 *
 * ⚠️ 档位回溯**必须被 groupStart 截断**。否则分节 1 的大包列（L/M）会一路回溯到非普货的
 * `0~2000g(含)`，把大包当成 2000g 档 —— 大包报价全错且不报任何错。
 *
 * 无类别行（燕文 / 4PX / 超级经济这一族）：整表不分品类 → 类别记为 `any`，
 * groupStart 退到首个数据列（此时不再需要按类别分界，档位回溯的上界由它兜住）。
 */
function resolveColumn(
  col: number,
  catRow: unknown[] | null,
  zoneRow: unknown[],
  leafRow: unknown[]
): ColumnContext | null {
  let groupStart = FIRST_DATA_COL;
  let title = '';
  if (catRow) {
    groupStart = col;
    while (groupStart > FIRST_DATA_COL && !cellText(catRow[groupStart])) groupStart--;
    title = cellText(catRow[groupStart]);
  }

  let zoneText = '';
  for (let z = col; z >= groupStart; z--) {
    const t = cellText(zoneRow[z]);
    if (t) {
      zoneText = t;
      break;
    }
  }

  const leafText = cellText(leafRow[col]);
  const zone = parseZoneRange(zoneText);
  // 限重可能写在类别标题里（`大包计费 限重30kg`）、也可能写在叶子里（`*每1g计重，限重2KG`）
  const limitG = parseLimitG(title) ?? parseLimitG(leafText) ?? null;

  return {
    groupStart,
    zoneText,
    categories: catRow ? parseCategories(title) : ['any'],
    variant: catRow ? parseVariant(title) : '',
    // 1g 的下界等价于"无下界"（`包裹重量为1-2000克`）——否则 0 克查询会判成"超出档位"
    minG: zone?.minG !== null && zone?.minG !== undefined && zone.minG > 1 ? zone.minG : 0,
    // 优先级：本列自己的档位上界 > 整组限重 > 大包限重兜底。
    // ⚠️ 顺序反了会静默算错：摩洛哥大包分两档（`0-5000g` 按 KG / `5000-30000g` 首重续重），
    //    而该组类别标题写着「大包计费 限重30kg」—— 若让限重盖过档位，
    //    按 KG 的那张卡会扩张到 0~30kg，把首重续重档整段吃掉。
    maxG: zone?.maxG ?? limitG ?? BULK_MAX_G,
    currency: parseCurrency(leafText),
  };
}

/**
 * 扫描探测出的表头行，构造价卡模板（相邻的 delivery+register / first+step 各成一张卡）。
 *
 * `warnings` 收的是**本节的**告警（调用方决定丢还是留）——建卡阶段的告警（"没有配对的挂号费"）
 * 在一节被整体拒绝后就没有意义了，混进总表会让用户按"挂号费按 0 计"去查一个根本没用上的节。
 *
 * 返回的 `minChargeCols` 是本节「最低计费重量」列的下标集合 —— 它的值写在**数据行**里
 * （如 `10g`），且可能与本卡不在同一列组（燕文那张：费率列在第 4 列、最低计费重量在第 8 列），
 * 所以只能逐行读，不能在建卡时定死。
 */
function buildTemplates(
  data: unknown[][],
  layout: HeaderLayout,
  sec: number,
  warnings: string[]
): { templates: CardTemplate[]; minChargeCols: number[] } {
  const catRow = layout.catRow >= 0 ? (data[layout.catRow] ?? []) : null;
  const zoneRow = layout.zoneRow >= 0 ? (data[layout.zoneRow] ?? []) : [];
  const leafRow = data[layout.leafRow] ?? [];
  const templates: CardTemplate[] = [];
  const minChargeCols: number[] = [];
  const width = Math.max(leafRow.length, zoneRow.length, catRow ? catRow.length : 0);
  const consumed = new Set<number>();

  // 「最低计费重量」列可能落在三个角色行里的**任意一个**上：燕文系列与档位同在表头行，
  // 威海优选仓同在表头行，中邮e邮宝则与叶子同行。只在叶子行找会漏掉前两者。
  const roleRows = [leafRow, zoneRow, catRow ?? []];
  const isMinChargeCol = (c: number): boolean =>
    roleRows.some((row) => leafKind(cellText(row[c])) === 'minCharge');

  for (let c = FIRST_DATA_COL; c < width; c++) {
    if (consumed.has(c)) continue;
    // 最低计费重量是"整节的列属性"，不参与建卡，只记下列号供逐行取值
    if (isMinChargeCol(c)) {
      minChargeCols.push(c);
      continue;
    }
    const kind = leafKind(cellText(leafRow[c]));
    // 只从「每张卡的第一列」起建卡（配送 / 首重），配对列由下一次循环跳过
    if (kind !== 'delivery' && kind !== 'first') continue;

    const ctx = resolveColumn(c, catRow, zoneRow, leafRow);
    if (!ctx) continue;
    if (!ctx.categories.length) {
      warnings.push(`分节 ${sec}：第 ${c + 1} 列的类别标题无法识别，该列已跳过`);
      continue;
    }

    const pairKind: LeafKind = kind === 'delivery' ? 'register' : 'step';
    let rateCol = -1;
    let registerCol = -1;
    let firstCol = -1;
    let stepCol = -1;

    if (kind === 'delivery') {
      rateCol = c;
      const next = resolveColumn(c + 1, catRow, zoneRow, leafRow);
      if (
        leafKind(cellText(leafRow[c + 1])) === pairKind &&
        next &&
        next.groupStart === ctx.groupStart &&
        next.zoneText === ctx.zoneText
      ) {
        registerCol = c + 1;
        consumed.add(c + 1);
      } else {
        warnings.push(
          `分节 ${sec}：第 ${c + 1} 列（配送服务费）没有配对的挂号服务费，挂号费按 0 计`
        );
      }
    } else {
      firstCol = c;
      const next = resolveColumn(c + 1, catRow, zoneRow, leafRow);
      if (
        leafKind(cellText(leafRow[c + 1])) === pairKind &&
        next &&
        next.groupStart === ctx.groupStart &&
        next.zoneText === ctx.zoneText
      ) {
        stepCol = c + 1;
        consumed.add(c + 1);
      } else {
        warnings.push(`分节 ${sec}：第 ${c + 1} 列（首重）没有配对的续重，续重按 0 计`);
      }
    }

    templates.push({
      ...ctx,
      mode: kind === 'delivery' ? 'perKg' : 'firstStep',
      rateCol,
      registerCol,
      firstCol,
      stepCol,
    });
  }

  return { templates, minChargeCols };
}

/**
 * 用某一数据行把模板实例化。
 *
 * 返回 null 有两种截然不同的含义，必须分开处理（否则警告会被淹没在噪声里）：
 *   · **该国不提供这个类别** —— 单元格为空、或写着「暂无服务」（分节 1 有 101 处）→ 静默跳过；
 *   · **数据异常** —— 单元格有内容但既不是数也不是"不提供"标记 → 记 warning（这才需要人看一眼）。
 */
function materialize(
  tpl: CardTemplate,
  row: unknown[],
  sec: number,
  nameCn: string,
  warnings: string[],
  minChargeCols: number[] = []
): RateCard | null {
  const readNum = (col: number, label: string): number | null | undefined => {
    if (col < 0) return null;
    const raw = cellText(row[col]);
    if (!raw) return null; // 空单元格 = 不提供该类别
    if (NOT_OFFERED_RE.test(raw)) return null; // 显式标注「暂无服务」= 不提供该类别
    const n = cellNum(raw);
    if (n === null) {
      warnings.push(`分节 ${sec} · ${nameCn}：${label}「${raw}」不是数值，该价卡已跳过`);
      return undefined; // undefined = 数据异常
    }
    return n;
  };

  // 最低计费重量是"整节列属性"，值写在数据行里；取第一个非空值
  let minChargeG = 0;
  for (const c of minChargeCols) {
    const v = parseGramValue(cellText(row[c]));
    if (v !== null) {
      minChargeG = v;
      break;
    }
  }

  const card: RateCard = {
    sec,
    categories: tpl.categories,
    variant: tpl.variant,
    minG: tpl.minG,
    maxG: tpl.maxG,
    mode: tpl.mode,
    ratePerKg: 0,
    registerFee: 0,
    firstFee: 0,
    stepFee: 0,
    baseG: BASE_G,
    stepG: STEP_G,
    currency: tpl.currency,
    minChargeG,
  };

  if (tpl.mode === 'perKg') {
    const rate = readNum(tpl.rateCol, '配送服务费');
    if (rate === undefined || rate === null) return null;
    card.ratePerKg = rate;
    if (tpl.registerCol >= 0 && cellText(row[tpl.registerCol])) {
      const reg = readNum(tpl.registerCol, '挂号服务费');
      if (reg === undefined) return null;
      card.registerFee = reg ?? 0;
    }
    return card;
  }

  const first = readNum(tpl.firstCol, '首重价');
  if (first === undefined || first === null) return null;
  card.firstFee = first;
  if (tpl.stepCol >= 0 && cellText(row[tpl.stepCol])) {
    const step = readNum(tpl.stepCol, '续重价');
    if (step === undefined) return null;
    card.stepFee = step ?? 0;
  }
  return card;
}

/**
 * 报价单 sheet（AOA）→ 归一化运价表。
 *
 * 输入是 `sheet_to_json(ws, { header: 1, defval: '' })` 的产物（行 × 列的二维数组）。
 * 不依赖任何固定列号：段内列结构一变就崩的写法在这张表上必然失败。
 *
 * @param rows 二维数组（缺行/缺列都容错）
 * @param sheetName 来源 sheet 名（仅记录用途）
 */
export function normalizeRateSheet(rows: unknown[][], sheetName = ''): RateTable {
  const data = Array.isArray(rows) ? rows : [];
  const warnings: string[] = [];
  const countries: CountryRate[] = [];
  const sections: RateSection[] = [];
  const firstSeenAt = new Map<string, number>();
  const currencies: Currency[] = [];
  let cards = 0;
  let perKgCards = 0;
  let firstStepCards = 0;

  const headerRows: number[] = [];
  for (let r = 0; r < data.length; r++) {
    if (isSectionHeader(cellText(data[r]?.[0]))) headerRows.push(r);
  }

  if (!headerRows.length) {
    warnings.push(
      `未找到任何「${HEADER_LABEL}」表头行 —— 该 sheet 不是报价单结构，未解析出任何运价`
    );
    return { sheetName, countries, sections, stats: emptyStats(), warnings };
  }

  for (let i = 0; i < headerRows.length; i++) {
    const sec = i + 1;
    const hdr = headerRows[i];
    const end = i + 1 < headerRows.length ? headerRows[i + 1] : data.length;

    // 表头行角色靠探测（1~3 行、且叶子行与档位行的上下顺序会颠倒），不能写死 hdr+1 / hdr+2
    const layout = detectLayout(data, hdr, end);
    if (!layout) {
      warnings.push(
        `分节 ${sec}（第 ${hdr + 1} 行）：未找到价卡表头行（配送服务费 / 挂号服务费 / 首重 / 续重），整节跳过`
      );
      continue;
    }

    // 本节告警先收在本地：只有整节被采纳时才并入总表（见 buildTemplates 的说明）
    const secWarnings: string[] = [];
    const { templates, minChargeCols } = buildTemplates(data, layout, sec, secWarnings);
    if (!templates.length) {
      warnings.push(`分节 ${sec}（第 ${hdr + 1} 行）：表头结构无法识别，整节跳过`);
      continue;
    }

    const secCategories = [...new Set(templates.flatMap((t) => t.categories))];
    const secCurrency = templates.find((t) => t.currency)?.currency ?? '';
    let secMinChargeG = 0;

    // 数据区起点 = 表头各角色行的最下一行之后（叶子在上、档位在下时 max 才落在档位行上）
    const dataStart = Math.max(layout.leafRow, layout.zoneRow) + 1;

    // 先收齐本节再决定要不要（见下方"行式分档表"判据）：一次不合格就整节丢弃，
    // 不能边扫边 push —— 否则会把半节脏数据落进运价表。
    const secRows: { code: string; nameCn: string; nameEn: string; cards: RateCard[] }[] = [];
    const secKeys = new Set<string>();
    let dupName = '';

    for (let r = dataStart; r < end; r++) {
      const row = data[r] ?? [];
      const nameCn = cellText(row[0]);
      if (!nameCn || isSectionHeader(nameCn)) continue;

      const list: RateCard[] = [];
      for (const tpl of templates) {
        const card = materialize(tpl, row, sec, nameCn, secWarnings, minChargeCols);
        if (!card) continue;
        list.push(card);
      }
      if (!list.length) continue;

      const code = cellText(row[2]);
      const nameEn = cellText(row[1]);
      const key = code || nameCn;
      if (secKeys.has(key)) dupName = dupName || nameCn;
      secKeys.add(key);
      secRows.push({ code, nameCn, nameEn, cards: list });
    }

    // ⚠️ 「同一节内同一目的地出现多行」= 该节把**重量分档写在数据行里**（一行一档），
    //    而本文件的数据模型是「国家 → 价卡[]」且**分档必须来自表头**（见 §1 的搬价卡模型）。
    //    实测这类表有 4 张：无忧物流-优先（20KG以下/20-30KG/31-69KG 三段逐列总价）、
    //    无忧物流-特货标准（价格起始/终止重量在列上）、无忧物流-特货标快、无忧物流-海运大件专线。
    //    它们能被"结构扫描"认出叶子列，但会算出**量纲完全错误**的金额（把"该档总价"当"每 KG 费率"）。
    //    所以宁可整节拒绝，也不产出看着像数、其实错的价 —— 前者用户立刻看得见，后者不会。
    if (dupName) {
      warnings.push(
        `分节 ${sec}（第 ${hdr + 1} 行）：「${dupName}」等目的地在本节内占多行 —— ` +
          `该节把重量分档写在数据行里，本版式不支持，整节跳过`
      );
      continue;
    }

    for (const r of secRows) {
      for (const card of r.cards) {
        cards++;
        if (card.mode === 'perKg') perKgCards++;
        else firstStepCards++;
        if (card.currency && !currencies.includes(card.currency)) currencies.push(card.currency);
      }
      const prev = firstSeenAt.get(r.code || r.nameCn);
      if (prev !== undefined) {
        warnings.push(`「${r.nameCn}」同时出现在分节 ${prev} 与分节 ${sec}，两处价卡均已保留`);
      } else {
        firstSeenAt.set(r.code || r.nameCn, sec);
      }
      secMinChargeG = Math.max(secMinChargeG, r.cards[0].minChargeG);
      countries.push(r);
    }
    // 节被采纳 → 这一节的告警才算数
    warnings.push(...secWarnings);

    sections.push({
      sec,
      headerRow: hdr + 1,
      countryCount: secRows.length,
      categories: secCategories,
      currency: secCurrency,
      minChargeG: secMinChargeG,
    });
  }

  return {
    sheetName,
    countries,
    sections,
    stats: {
      sections: sections.length,
      countries: countries.length,
      cards,
      perKgCards,
      firstStepCards,
      currencies,
    },
    warnings,
  };
}

function emptyStats(): RateTableStats {
  return {
    sections: 0,
    countries: 0,
    cards: 0,
    perKgCards: 0,
    firstStepCards: 0,
    currencies: [],
  };
}

// ─────────────────────────────────────────────────────────── 自动选表

/**
 * 自动选表时的名称提示。
 *
 * ⚠️ 报价单工作簿**不是一个 sheet**：运营商的原始文件有 21 个 sheet（第一张是「目录」，
 * 其后是 20 条线路各自的报价单），目标表在**第 10 张**。所以"没指定就取第一个 sheet"
 * 必然解析失败，而且报出来的是「不是报价单结构」—— 像是数据有问题，
 * 真实原因是**读错了工作表**。此常量把"默认取哪张"从"工作簿顺序"改成"名称语义"。
 */
export const DEFAULT_SHEET_HINT = '无忧物流-标准';

/** 单个候选 sheet 的体检结果（供岛展示"试过哪些、各有多少国家"） */
export interface SheetScanCandidate {
  sheetName: string;
  countries: number;
  cards: number;
  sections: number;
  /** 未解析出运价时的第一条原因；解析成功为空串 */
  reason: string;
}

/** 一张 sheet 的体检输入 */
export interface SheetScan {
  sheetName: string;
  table: RateTable;
}

export interface RateSheetPick {
  /** 选中的 sheet 名；一个都不可用时为空串 */
  sheetName: string;
  /** 全部候选（按工作簿顺序，**含不可用的**，各带原因） */
  candidates: SheetScanCandidate[];
}

/**
 * 从整本工作簿的体检结果里挑出报价单所在的那张表。
 *
 * 排序依据（前一项赢）：
 *   ① 名称与提示**完全相同** —— `无忧物流-标准` 必须赢过 `无忧物流-标准-三方清关`（后者只有 1 国 5 卡）；
 *   ② 名称**包含**提示，且名字越短越接近 —— 能在"标准"与"标准-威海优选仓"之间选出前者；
 *   ③ 国家数多者优先 —— 同名家族有多个时，宽表更可能是主表；
 *   ④ 价卡数多者优先；
 *   ⑤ 工作簿顺序兜底 —— 保证"同输入同结果"，否则排序不稳定会让用户看到随机选表。
 *
 * 国家数为 0 的 sheet 一律不参与排序：它们只作为候选回报给岛，
 * 让用户在"自动挑错了"时能看到有哪些可选、而不是被一句"结构无法识别"堵死。
 */
export function pickRateSheet(scans: SheetScan[], prefer = ''): RateSheetPick {
  const candidates: SheetScanCandidate[] = scans.map(({ sheetName, table }) => ({
    sheetName,
    countries: table.stats.countries,
    cards: table.stats.cards,
    sections: table.stats.sections,
    reason: table.stats.countries ? '' : table.warnings[0] || '未解析出运价',
  }));

  const hint = cellText(prefer);
  const usable = scans.map((s, i) => ({ s, c: candidates[i], i })).filter((x) => x.c.countries > 0);
  if (!usable.length) return { sheetName: '', candidates };

  const nameRank = (name: string): number => {
    if (!hint) return 0;
    if (name === hint) return 1000;
    if (!name.includes(hint)) return 0;
    // 命中近似名：用名字长度做二级区分（越短越接近提示），下界仍 > 0
    return 500 - Math.min(name.length, 400);
  };

  usable.sort((a, b) => {
    const byName = nameRank(b.s.sheetName) - nameRank(a.s.sheetName);
    if (byName) return byName;
    if (b.c.countries !== a.c.countries) return b.c.countries - a.c.countries;
    if (b.c.cards !== a.c.cards) return b.c.cards - a.c.cards;
    return a.i - b.i;
  });

  return { sheetName: usable[0].s.sheetName, candidates };
}
