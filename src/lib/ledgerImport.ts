// src/lib/ledgerImport.ts
// 「记账 › 批量导入账单明细」的解析与校验层（**纯函数**，零副作用，可 vitest）。
//
// 为什么解析放这里而不是主进程（与 `productImport.ts` 同一个理由）：
//   ① 三层边界要求主进程不 import 渲染层代码（AGENTS.md §1.1）；
//   ② **口径只能有一份** —— 「哪列是金额」「分摊店铺怎么断」「百分比合不合」若在渲染层
//      和主进程各写一遍，两份实现必然漂移，而漂移的表现是"预览说能导、落库却少钱"；
//   ③ 纯函数能被 vitest 覆盖，碰 SQLite 的那层测不了（better-sqlite3 是 Electron ABI）。
//
// ⚠️ 本文件**不算钱**：金额解析走 `ledger.parseYuanToCents` / `assertAmountCents`，
//    分摊走 `ledger.computeAllocations`，营收权重走 `ledgerRevenue.participantRevenueCents`。
//    方案 §5.5 说"出现非渲染层写入方才把算法下沉"—— 批量导入刻意**仍是渲染层写入方**
//    （渲染层解析+校验+算分摊，主进程只把校验过的行落库并做守恒断言），所以算法不下沉。
//    这条决定写进 `docs/notes/`，别下次又被"顺手把解析挪到主进程"推翻。
//
// 三段流水线（界面按此顺序调用，也让"要问宿主拿什么"变得显式）：
//   ① `pickLedgerImportSheet` —— 哪张表、表头在第几行、每族落在哪列
//   ② `parseLedgerImportRows` —— 单元格语法（日期/金额/方向/基准/归属/分摊店铺文法）
//   ③ `resolveLedgerImportRows` —— 名字对 id（宿主算的归一键，见下）、摊钱、指纹查重
//
// 名字对 id **不在渲染层做归一化**：`toNameKey`（去零宽、压空白）在主进程，渲染层抄一份就是
// 第二实现（同 `ledgerRevenue.ts` 的做法：宿主把 `nameKey` 算好送过来，本层只用）。
// 所以 `resolveLedgerImportRows` 吃的是 `refs`（由 `ledger-name-resolve` 通道产出），
// 本文件只认 `refs` 的结论，绝不"看着像就当同一个"。
//
// 三条判据（与「记一笔」的边界**有一处刻意不同**，写在这里免得下次被"统一"掉）：
//   · 相关人/科目：**库里没有就新建**（用户要求：一份账单导进来不该先去手工建十个相关人）。
//     与「记一笔」的差别是有意的 —— 那条路是逐笔手填，名字找不到就是打错了字，必须报错；
//     这条路用户是拿现成的表来对账，名字本来就在表里。新建发生在**落库的同一个事务**里
//     （`batchCreateEntries` 的 `partyName` / `categoryName`），并逐行标出「将新建」让人核对
//     —— 打错一个字仍然会凭空多出一个"假房东"，所以预览必须把它摆到明面上，且默认勾选同样适用。
//     店铺**仍然不新建**：店是基础数据域的实体（平台/账号/企业一串信息），跨域凭空建半个店比报错更糟。
//   · **不更新已有条目**：账目没有业务主键（同一笔房租可以记两遍），所以导入只新增。
//   · **不产生结算单**：文件里填了「结算状态」也只会是未结算，逐行说明，别让半份文件冒充已结。

import {
  assertAmountCents,
  computeAllocations,
  conservationGap,
  formatCents,
  isValidBizDate,
  parseYuanToCents,
  periodOf,
  type AllocParticipant,
  type AllocationRow,
  type LedgerBasis,
} from './ledger';
import { participantRevenueCents, type LedgerRevenue } from './ledgerRevenue';
import type {
  LedgerEntryRow,
  LedgerImportEntryInput,
  LedgerKind,
  LedgerNameHit,
  LedgerNameResolveResult,
  LedgerScope,
} from '@/types';

// ---------------------------------------------------------------------------
// ① 列定义（模板、识别、界面回显的**唯一来源**）
// ---------------------------------------------------------------------------

export type LedgerImportColumnKey =
  | 'bizDate'
  | 'kind'
  | 'amount'
  | 'party'
  | 'category'
  | 'shop'
  | 'allocShops'
  | 'basis'
  | 'scope'
  | 'settle'
  | 'note';

export interface LedgerImportColumnDef {
  key: LedgerImportColumnKey;
  /** 表头原文（也是识别的精确档第一项）；界面列名与模板都取它，不各写一遍 */
  label: string;
  /** 必填：缺列或缺值都会让这一笔钱落不进正确的桶 */
  required: boolean;
  /** 是否出现在下载模板里。`settle` 认得但**不发**：导入不产生结算单，发出去等于邀请用户填一个不生效的列 */
  inTemplate: boolean;
  /** 同义写法（先精确、后包含）。**只收真实出现过的写法** —— 加宽一档会把别的列抢走 */
  aliases: readonly string[];
  /** 这一列填什么（进「填写说明」表） */
  hint: string;
  /** 示例值（进「填写说明」表，不进数据表 —— 示例行被误导就是假账） */
  example: string;
}

export const LEDGER_IMPORT_COLUMNS: readonly LedgerImportColumnDef[] = [
  {
    key: 'bizDate',
    label: '发生日期*',
    required: true,
    inTemplate: true,
    aliases: ['发生日期', '业务日期', '记账日期', '交易日期', '日期', 'date', 'bizdate'],
    hint: '这笔钱实际发生的那天（不是录入的今天）。2026-10-01 / 2026/10/1 / 2026年10月1日 都认',
    example: '2026-10-01',
  },
  {
    key: 'kind',
    label: '方向*',
    required: true,
    inTemplate: true,
    aliases: ['收/支', '收支', '方向', '款项方向', '收付方向', 'kind'],
    hint: '收入 或 支出。金额一律填正数，收还是支只看这一列',
    example: '支出',
  },
  {
    key: 'amount',
    label: '金额(元)*',
    required: true,
    inTemplate: true,
    aliases: ['金额', '发生金额', '交易金额', '收支金额', 'amount'],
    hint: '单位元，带 ¥ 或逗号也认（¥1,200.50）；超过两位小数自动四舍五入到分，并在预览里逐行提示',
    example: '1200.50',
  },
  {
    key: 'party',
    label: '相关人*',
    required: true,
    inTemplate: true,
    aliases: ['相关人', '资金相关人', '往来对象', '交易对象', '对方', 'party'],
    hint: '这笔钱付给谁 / 谁付给我。库里没有这个名字会**按表里的写法自动新建**（打错字就会多出一个错的往来对象，预览里会标「将新建相关人」）',
    example: '房东老王',
  },
  {
    key: 'category',
    label: '科目',
    required: false,
    inTemplate: true,
    aliases: ['科目', '费用科目', '收入科目', '记账科目', '科目名称', 'category'],
    hint: '可留空。库里没有会自动新建；方向要匹配（支出科目不能挂在收入上）',
    example: '房租',
  },
  {
    key: 'shop',
    label: '店铺',
    required: false,
    inTemplate: true,
    aliases: ['店铺', '店铺名称', '店名', '归属店铺', '所属店铺', 'shop'],
    hint: '专属某一家店才填。与「分摊店铺」互斥：一家店掏钱填这里，几家店一起摊填那边',
    example: 'AE 旗舰店',
  },
  {
    key: 'allocShops',
    label: '分摊店铺',
    required: false,
    inTemplate: true,
    aliases: ['分摊店铺', '参与分摊店铺', '分摊到店铺', '参与店铺', '分摊门店'],
    hint: '公共支出摊给哪几家店，用 、 , ; | / 分隔；写「全部」= 当期营业中的店都摊；' +
      '带百分比（如 店A=60%、店B=40%）就是手工比例，合计必须正好 100%',
    example: 'AE 旗舰店=60%、AE 二店=40%',
  },
  {
    key: 'basis',
    label: '分摊基准',
    required: false,
    inTemplate: true,
    aliases: ['分摊基准', '基准', '分摊方式', '分配方式', 'basis'],
    hint: '公共支出才用：平均分摊 / 按营收占比 / 手工比例。留空按平均分摊（分摊店铺里写了百分比则按手工比例）',
    example: '按营收占比',
  },
  {
    key: 'scope',
    label: '归属',
    required: false,
    inTemplate: true,
    aliases: ['归属', '范围', '是否公共', 'scope'],
    hint: '专属 / 公共。可以从「店铺」「分摊店铺」推出来，填了就必须和推出来的结果一致',
    example: '公共',
  },
  {
    key: 'settle',
    label: '结算状态',
    required: false,
    inTemplate: false,
    aliases: ['结算状态', '是否已结算', '结算', 'settle'],
    hint: '认得这一列但导入不生效：结没结清走「往来」页签做，那里会连带改余额与结算单',
    example: '已结算',
  },
  {
    key: 'note',
    label: '备注',
    required: false,
    inTemplate: true,
    aliases: ['备注', '说明', '摘要', '附注', '描述', 'note'],
    hint: '可留空',
    example: '10 月房租，微信转的',
  },
];

/**
 * 列族分配顺序 —— **顺序即判据，别随手调**。
 *
 * 两条必须成立的先后：
 *   · `allocShops` 在 `shop` **之前**：「分摊店铺」里含「店铺」，反过来分配会让公共那笔
 *     的店铺名单被当成"专属哪家店"，于是这笔钱只落到第一家头上（2026-10-09 产品导入同类坑）。
 *   · `shop` 在 `scope` **之前**：「归属店铺」含「归属」，被 `scope` 抢走后这行就没有店铺了。
 */
const RESOLVE_ORDER: readonly LedgerImportColumnKey[] = [
  'bizDate',
  'kind',
  'amount',
  'allocShops',
  'shop',
  'scope',
  'basis',
  'settle',
  'party',
  'category',
  'note',
];

const COLUMN_BY_KEY = new Map(LEDGER_IMPORT_COLUMNS.map((c) => [c.key, c]));

/** 模板里真正出现的列（下载模板与「按这些列读的」回显共用一份） */
export const LEDGER_TEMPLATE_COLUMNS: readonly LedgerImportColumnDef[] = LEDGER_IMPORT_COLUMNS.filter(
  (c) => c.inTemplate,
);

export type LedgerImportColumns = Record<LedgerImportColumnKey, number>;

const EMPTY_COLUMNS: LedgerImportColumns = LEDGER_IMPORT_COLUMNS.reduce((acc, c) => {
  acc[c.key] = -1;
  return acc;
}, {} as LedgerImportColumns);

/** 一次导入的行数上限（超过就是"这份文件不是给记账用的"，让用户先筛，别默默吞掉尾部） */
export const LEDGER_IMPORT_MAX_ROWS = 2000;

/** 表头最多往下找几行（有些导出前面塞了标题、筛选说明） */
const HEADER_SCAN_ROWS = 30;

// ---------------------------------------------------------------------------
// 通用单元格取值
// ---------------------------------------------------------------------------

/** 表头归一：去空白 / 去必填星号 / 去括号注记 / 转小写（与 `productImport` 同一套写法） */
function normHeader(v: unknown): string {
  return String(v ?? '')
    .replace(/\s+/g, '')
    .replace(/[*＊]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .toLowerCase();
}

/** 单元格取文本（数字也当文本；`Date` 与空值各有归属，见下方专用解析） */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v).trim();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// ② 选表 + 列表头
// ---------------------------------------------------------------------------

export interface LedgerImportSheet {
  name: string;
  grid: unknown[][];
}

/** 一张表的表头体检结论（`verdict` 是人话，落选时逐表显示 —— 用户需要知道"软件看过哪些表"） */
export interface LedgerImportHeaderScan {
  sheetName: string;
  /** 表头所在行（0-based）；-1 = 这张表没有合格表头 */
  headerRow: number;
  columns: LedgerImportColumns;
  /** 表头原文（界面回显「按这些列读的」） */
  headers: string[];
  /** 表头以下的非空行数 */
  dataRows: number;
  qualified: boolean;
  verdict: string;
}

/** 为每个族挑一列：先精确命中，再退到包含（长键优先），已占用的列不再分配 */
function resolveColumns(headerRow: unknown[]): LedgerImportColumns {
  const norm = headerRow.map(normHeader);
  const taken = new Set<number>();
  const out: LedgerImportColumns = { ...EMPTY_COLUMNS };

  for (const key of RESOLVE_ORDER) {
    const def = COLUMN_BY_KEY.get(key);
    if (!def) continue;
    const family = def.aliases.map(normHeader);
    let hit = -1;
    for (let i = 0; i < norm.length && hit === -1; i++) {
      if (taken.has(i) || !norm[i]) continue;
      if (family.includes(norm[i])) hit = i;
    }
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

function matchedCount(columns: LedgerImportColumns): number {
  return LEDGER_IMPORT_COLUMNS.reduce((n, c) => n + (columns[c.key] !== -1 ? 1 : 0), 0);
}

/**
 * 一张表够不够格当"账单明细表"：**日期 + 金额 + （相关人 或 店铺 或 分摊店铺）**，且至少认出 3 列。
 *
 * 为什么要求到"谁/哪家店"这一维：只有日期和金额的两列流水（银行对账单、支付宝账单）
 * 谁都能长得一样，认下来就会把整份流水当成账目落库，而每一笔都缺相关人 —— 全行报错的
 * 界面比"默默导进 200 行无法归属的钱"好看得多，所以宁可不认。
 * 「3 列」这条则挡掉"两个不相干的文件凑巧各有日期金额"的情况。
 */
function qualifies(columns: LedgerImportColumns): boolean {
  const hasWho = columns.party !== -1 || columns.shop !== -1 || columns.allocShops !== -1;
  return columns.bizDate !== -1 && columns.amount !== -1 && hasWho && matchedCount(columns) >= 3;
}

function labelList(columns: LedgerImportColumns): string {
  const hit = LEDGER_IMPORT_COLUMNS.filter((c) => columns[c.key] !== -1).map((c) => c.label);
  return hit.length ? hit.join(' / ') : '没有可对上的列';
}

function scanSheet(sheet: LedgerImportSheet): LedgerImportHeaderScan {
  const grid = Array.isArray(sheet.grid) ? sheet.grid : [];
  const limit = Math.min(grid.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < limit; r++) {
    const columns = resolveColumns(grid[r] ?? []);
    if (!qualifies(columns)) continue;
    const dataRows = grid
      .slice(r + 1)
      .filter((row) => Array.isArray(row) && row.some((c) => cellText(c) !== '' || c instanceof Date)).length;
    return {
      sheetName: sheet.name,
      headerRow: r,
      columns,
      headers: (grid[r] ?? []).map((h) => String(h ?? '')),
      dataRows,
      qualified: true,
      verdict: `第 ${r + 1} 行是表头，认出 ${matchedCount(columns)} 列（${labelList(columns)}），下面 ${dataRows} 行数据`,
    };
  }
  const last = limit ? resolveColumns(grid[limit - 1] ?? []) : { ...EMPTY_COLUMNS };
  return {
    sheetName: sheet.name,
    headerRow: -1,
    columns: { ...EMPTY_COLUMNS },
    headers: [],
    dataRows: 0,
    qualified: false,
    verdict: limit
      ? `前 ${limit} 行里没凑齐「发生日期 + 金额 + 相关人/店铺」${
          last.bizDate === -1 ? '（连日期列都没找到）' : ''
        }`
      : '这张表是空的',
  };
}

/** 逐表体检（落选时界面要显示每张表的结论） */
export function scanLedgerImportSheets(sheets: readonly LedgerImportSheet[]): LedgerImportHeaderScan[] {
  return (Array.isArray(sheets) ? sheets : []).map(scanSheet);
}

/**
 * 选哪张表：**合格表里数据行最多的那张**，不靠位置。
 *
 * 「取第一张」在真文件上是错的 —— 一份工作簿常有「汇总」「明细」「填写说明」，
 * 说明表可能排在最前面，而它只有表头。（同 `settleImport.pickSettleSheet` 的判据来源。）
 */
export function pickLedgerImportSheet(sheets: readonly LedgerImportSheet[]): {
  picked: LedgerImportHeaderScan | null;
  scanned: string[];
} {
  const scans = scanLedgerImportSheets(sheets);
  const ok = scans.filter((s) => s.qualified);
  ok.sort((a, b) => b.dataRows - a.dataRows || a.headerRow - b.headerRow);
  return {
    picked: ok.length ? ok[0] : null,
    scanned: scans.map((s) => `${s.sheetName}：${s.verdict}`),
  };
}

// ---------------------------------------------------------------------------
// ③ 单元格语法
// ---------------------------------------------------------------------------

/** Excel 日期序列号的基准（1899-12-30；SheetJS 不带 `cellDates` 时日期是数字） */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
/** 序列号合理区间：这段之外一律当"不是日期"处理，而不是当成 1902 年的账 */
const DATE_MIN_TEXT = '1980-01-01';
const DATE_MAX_TEXT = '2100-12-31';

function dateFromParts(y: number, m: number, d: number): string {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return '';
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const text = `${y}-${pad2(m)}-${pad2(d)}`;
  return isValidBizDate(text) ? text : '';
}

/** 8 位数字（20261001）—— 银行流水常见；序列号不会到 8 位，两者不会撞 */
function dateFromYmdNumber(n: number): string {
  if (!Number.isInteger(n)) return '';
  const s = String(n);
  if (s.length !== 8) return '';
  return dateFromParts(Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8)));
}

function dateFromSerial(n: number): string {
  const days = Math.floor(n);
  if (days < 1) return '';
  const dt = new Date(EXCEL_EPOCH_UTC + days * 86400000);
  if (Number.isNaN(dt.getTime())) return '';
  const text = dateFromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  return text && text >= DATE_MIN_TEXT && text <= DATE_MAX_TEXT ? text : '';
}

/** 文本日期：认 `2026-10-01` / `2026/10/1` / `2026.10.1` / `2026年10月1日`，带时间的取前半 */
function dateFromText(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const head = s.split(' ')[0];
  const normalized = head
    .replace(/[年月]/g, '-')
    .replace(/日/g, '')
    .replace(/[/.]/g, '-')
    .replace(/-/g, '-');
  const parts = normalized.split('-').filter((x) => x !== '');
  if (parts.length !== 3) return '';
  if (!/^\d{4}$/.test(parts[0])) return '';
  // 月/日在前的写法（美式 10/01/2026）**不猜**：猜错的日期会把钱记到别的月份，
  // 而"10 月 1 日"和"1 月 10 日"在界面上都像是"导入成功"。
  if (!/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) return '';
  return dateFromParts(Number(parts[0]), Number(parts[1]), Number(parts[2]));
}

/**
 * 日期单元格 → `YYYY-MM-DD`。
 * @returns `{ text, error }`：`text` 空 + `error` 空 = 这格没填（必填判定交给调用方）
 */
export function parseImportDateCell(v: unknown): { text: string; error: string } {
  if (v === null || v === undefined || v === '') return { text: '', error: '' };
  if (v instanceof Date) {
    const text = dateFromParts(v.getFullYear(), v.getMonth() + 1, v.getDate());
    return text ? { text, error: '' } : { text: '', error: '日期不是一个真实存在的日子' };
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { text: '', error: '日期是一个空值' };
    const ymd = dateFromYmdNumber(v);
    if (ymd) return { text: ymd, error: '' };
    const serial = dateFromSerial(v);
    if (serial) return { text: serial, error: '' };
    return {
      text: '',
      error: `日期这一格读到的是数字 ${v}，不像日期（Excel 里可能把格式改成了数值）。请写成 2026-10-01 这种`,
    };
  }
  const raw = String(v).trim();
  if (/^\d{6}$/.test(raw)) {
    return { text: '', error: `日期只到月（${raw}）：每笔账要落到具体那天` };
  }
  if (/^\d{4}[-/.]\d{1,2}$/.test(raw)) {
    return { text: '', error: `日期只到月（${raw}）：每笔账要落到具体那天` };
  }
  if (/^\d{8}$/.test(raw)) {
    const ymd = dateFromYmdNumber(Number(raw));
    if (ymd) return { text: ymd, error: '' };
  }
  const text = dateFromText(raw);
  if (text) return { text, error: '' };
  return { text: '', error: `日期「${raw}」看不懂：请用 2026-10-01 / 2026/10/1 / 2026年10月1日 这种写法` };
}

const KIND_TOKENS: Record<LedgerKind, readonly string[]> = {
  income: ['收入', '收', '入账', '收款', '进账', 'income'],
  expense: ['支出', '支', '出账', '扣款', '付款', '费用', 'expense'],
};

/** 方向单元格：只认这几枚写法，别的（「+100」/「Cr」）一律报错 —— 方向搞反整批的符号就反了 */
export function parseImportKindCell(v: unknown): { kind: LedgerKind | ''; error: string } {
  const raw = cellText(v);
  if (!raw) return { kind: '', error: '' };
  const norm = raw.replace(/\s+/g, '').toLowerCase();
  for (const kind of ['income', 'expense'] as LedgerKind[]) {
    if (KIND_TOKENS[kind].map((t) => t.toLowerCase()).includes(norm)) return { kind, error: '' };
  }
  return { kind: '', error: `方向「${raw}」看不懂：只能填「收入」或「支出」` };
}

/**
 * 金额单元格 → 整数分。**超过两位小数自动四舍五入到两位**（导入只记到分）。
 *
 * 三步，顺序不能颠倒：
 *   ① 数字格先转成十进制字符串（`toFixed(6)` 再去尾零），文本格原样 trim ——
 *      两条路从此**走同一段字符串算术**，不会出现"Excel 里 1200.505 进成 1200.50、
 *      手打成文本却进 1200.51"这种同一份文件两种结果的漂移；
 *   ② 先交给 `parseYuanToCents`（与「记一笔」同一份实现）：两位以内的一切写法
 *      （`1200.5` / `¥1,200.50` / 前后空白）结论**必须一模一样**，这里不自作聪明；
 *   ③ 严格口径认不出时才走本层的"多余小数位"分支：只按**十进制第三位**半进一，
 *      全程字符串/整数，不碰浮点（`1.005 * 100 = 100.49999999999999`）。
 *
 * 取整**绝不静默**：改过值就回一句 `rounded`，由调用方塞进该行 warn、界面上逐行念出来
 * （"1.005 → 1.01"）。用户要的是别卡住导入，不是要账上少几厘还没人告诉他。
 * 取整后成 0（`0.004`）不走"金额必填"：那是"太小了"，两句话要说清是两件事。
 * 负数单独给一句人话：银行流水习惯把支出记成负数，但本项目的方向由「方向」列决定，
 * 静默取绝对值会让"填错方向"这笔钱看起来完全正常。
 */
export function parseImportAmountCell(v: unknown): {
  cents: number;
  error: string;
  /** 非空 = 原值超过两位小数、已按四舍五入记到分（文案直接给人看） */
  rounded: string;
} {
  if (v === null || v === undefined || v === '') return { cents: 0, error: '', rounded: '' };
  if (typeof v === 'number' && !Number.isFinite(v)) return { cents: 0, error: '金额是一个空值', rounded: '' };

  // ① 统一成十进制字符串
  let s: string;
  if (typeof v === 'number') {
    s = v.toFixed(6);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  } else {
    s = String(v).trim();
  }
  if (s.startsWith('-')) {
    return { cents: 0, error: `金额是负数（${s}）：请填正数，收还是支由「方向」这一列决定`, rounded: '' };
  }
  const compact = s.replace(/^[¥￥]\s*/, '').replace(/,/g, '').replace(/\s+/g, '');

  // ② 两位以内：交给唯一实现（与输入框同一条口径）
  const strict = parseYuanToCents(compact);
  if (strict !== null) return { cents: strict, error: '', rounded: '' };

  // ③ 多余小数位 → 十进制半进一（`formatCents` 只用于文案，值仍以整数分为准）
  const m = /^(\d+)(?:\.(\d+))?$/.exec(compact);
  if (!m) {
    return { cents: 0, error: `金额「${s}」看不懂：填 1200.50 这种（元）`, rounded: '' };
  }
  const intPart = m[1];
  const dec = m[2] ?? '';
  if (intPart.length > 10) {
    return { cents: 0, error: `金额「${s}」超出上限（单笔最多 10 亿元）`, rounded: '' };
  }
  let cents = Number(intPart) * 100 + Number(dec.slice(0, 2).padEnd(2, '0'));
  const rest = dec.slice(2);
  if (rest && Number(rest[0]) >= 5) cents += 1;

  if (cents <= 0) {
    // 「写了个 0」和「小到记不了」是两件事：同一个"金额必填"会让人回去检查单元格是不是空的
    const zeroLiteral = !/[1-9]/.test(dec);
    return {
      cents: 0,
      error: zeroLiteral
        ? '金额必须大于 0'
        : `金额「${s}」保留两位小数后是 0.00：导入只记到分，这么小的金额记不了`,
      rounded: '',
    };
  }
  try {
    const ok = assertAmountCents(cents);
    // 只有真的改动过数值才提示：`1200.500` 这种尾零不是"取整"
    const changed = /[1-9]/.test(rest);
    return {
      cents: ok,
      error: '',
      rounded: changed ? `金额 ${s} 超过两位小数，已按四舍五入记为 ${formatCents(ok)}（导入只记到分）` : '',
    };
  } catch (e: unknown) {
    return { cents: 0, error: e instanceof Error ? e.message : String(e), rounded: '' };
  }
}

const BASIS_TOKENS: Record<LedgerBasis, readonly string[]> = {
  equal: ['平均', '平均分摊', '平均分配', '按平均', 'equal'],
  revenue: ['营收', '按营收占比', '营收占比', '按营收', 'revenue'],
  manual: ['手工', '手工比例', '手工分摊', '按比例', 'manual'],
};

/** 分摊基准单元格；认不出报错（留空由调用方按"平均分摊"处理并标注为推断） */
export function parseImportBasisCell(v: unknown): { basis: LedgerBasis | ''; error: string } {
  const raw = cellText(v);
  if (!raw) return { basis: '', error: '' };
  const norm = raw.replace(/\s+/g, '').toLowerCase();
  for (const basis of ['equal', 'revenue', 'manual'] as LedgerBasis[]) {
    if (BASIS_TOKENS[basis].map((t) => t.toLowerCase()).includes(norm)) return { basis, error: '' };
  }
  return { basis: '', error: `分摊基准「${raw}」看不懂：只能填 平均分摊 / 按营收占比 / 手工比例` };
}

const SCOPE_TOKENS: Record<LedgerScope, readonly string[]> = {
  shop: ['专属', '这家店', '单店', '本店铺', '店铺', 'shop'],
  shared: ['公共', '公摊', '全部', '所有', '全部门店', '各店', 'shared'],
};

/** 归属单元格；认不出报错（它一旦认错，公共支出会变成只落一家店的专属支出） */
export function parseImportScopeCell(v: unknown): { scope: LedgerScope | ''; error: string } {
  const raw = cellText(v);
  if (!raw) return { scope: '', error: '' };
  const norm = raw.replace(/\s+/g, '').toLowerCase();
  for (const scope of ['shop', 'shared'] as LedgerScope[]) {
    if (SCOPE_TOKENS[scope].map((t) => t.toLowerCase()).includes(norm)) return { scope, error: '' };
  }
  return { scope: '', error: `归属「${raw}」看不懂：只能填 专属 或 公共` };
}

/**
 * 「分摊店铺」分隔符。
 *
 * ⚠️ **空白不算分隔**：店名本身含空格（`AE Flagship Store`、`店铺 A`），
 * 一旦按空格切，一个店名会变成两行"不存在的店"，报错还会误导用户去改店名。
 */
const ALLOC_SEPARATOR = /[、，,;；|/]+/;
const ALL_TOKENS = ['全部', '所有', '全部店', '所有店', '全部店铺', '所有店铺', '全部店店铺'];
const ALLOC_MAX_SHOPS = 200;

export interface LedgerImportAllocToken {
  /** 原文（去空白后） */
  raw: string;
  /** 店名部分 */
  shop: string;
  /** 百分比（0~100，最多两位小数）；null = 这格没写比例 */
  pct: number | null;
  /** true = 「全部」这类整体占位符，展开成当期店铺 */
  all: boolean;
  error: string;
}

/** 百分比文本 → 数值（认 `60` / `60%` / `60.5％`）；不合法返回 null */
function parsePct(raw: string): number | null {
  const s = raw.replace(/\s+/g, '').replace(/％/g, '%').replace(/%$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return n;
}

/**
 * 拆「分摊店铺」单元格。
 * @returns `{ tokens, hasPct, error }`：`hasPct` = 至少一个 token 带了百分比（据此推断手工比例）
 */
export function parseImportAllocCell(v: unknown): {
  tokens: LedgerImportAllocToken[];
  hasPct: boolean;
  errors: string[];
} {
  const raw = cellText(v);
  if (!raw) return { tokens: [], hasPct: false, errors: [] };
  const errors: string[] = [];
  const parts = raw
    .split(ALLOC_SEPARATOR)
    .map((x) => x.trim())
    .filter((x) => x !== '');
  if (!parts.length) return { tokens: [], hasPct: false, errors: ['「分摊店铺」这一格只有分隔符，没有店名'] };

  const tokens: LedgerImportAllocToken[] = [];
  for (const part of parts) {
    const compact = part.replace(/\s+/g, '');
    if (ALL_TOKENS.includes(compact.toLowerCase()) || ALL_TOKENS.includes(compact)) {
      tokens.push({ raw: part, shop: '', pct: null, all: true, error: '' });
      continue;
    }
    const eq = part.indexOf('=');
    if (eq === -1) {
      tokens.push({ raw: part, shop: part, pct: null, all: false, error: '' });
      continue;
    }
    const shop = part.slice(0, eq).trim();
    const pct = parsePct(part.slice(eq + 1));
    if (!shop) {
      errors.push(`分摊店铺「${part}」缺少店名（等号左边是空的）`);
      continue;
    }
    if (pct === null) {
      errors.push(`分摊店铺「${part}」的比例不合法：写成 店名=60% 这样（0~100，最多两位小数）`);
      continue;
    }
    tokens.push({ raw: part, shop, pct, all: false, error: '' });
  }

  // 一半带比例、一半不带 = 用户以为"没写的那几家平均分剩下的"。这不是我们能替他决定的事。
  const anyPct = tokens.some((t) => t.pct !== null);
  const anyPlain = tokens.some((t) => t.pct === null && !t.all);
  if (anyPct && anyPlain) {
    errors.push('分摊店铺里带百分比和空着不带的混着写了：要么每家都给百分比（手工比例），要么都不给');
  }
  return { tokens, hasPct: anyPct, errors };
}

// ---------------------------------------------------------------------------
// ② 逐行取原始值
// ---------------------------------------------------------------------------

export interface LedgerImportCellRow {
  /** Excel 行号（1-based，含表头行，用户回表核对要的就是这个数） */
  rowNo: number;
  /** 各列原文（键 = 列 key；界面"看原文"与逐行编辑都取它） */
  cells: Partial<Record<LedgerImportColumnKey, string>>;
  bizDate: string;
  kind: LedgerKind | '';
  amountCents: number;
  /** 金额超过两位小数、已自动取整到分（界面汇总条单独计数，别混进"像已记过"里） */
  amountRounded: boolean;
  party: string;
  category: string;
  shop: string;
  alloc: LedgerImportAllocToken[];
  basis: LedgerBasis | '';
  scope: LedgerScope | '';
  /** 「分摊店铺」里是否出现百分比（据此把基准判成手工比例） */
  hasAllocPct: boolean;
  settle: string;
  note: string;
  /** 值本身就不合法（日期/金额/方向/基准/归属/分摊文法）—— 与"名字对不上"分两阶段，好定位 */
  errors: string[];
  /** 整行没写百分比但混用等号之类只需要提示的情况 */
  warns: string[];
}

/** 该列在表头里的位置（-1 = 这份文件没有这一列 → 一律读成空） */
function cellAt(row: unknown[], index: number): unknown {
  return index === -1 ? '' : row[index];
}

/**
 * 表头以下的每一行 → 原始值 + 值级错误。
 *
 * 返回**全部行**（含不合格行）：和 `productImport` 一样，界面要让用户看得见"哪一行读成了什么"，
 * 只回合格行会让"跳过这行"变成一个不可能实现的按钮。
 */
export function parseLedgerImportRows(
  sheet: LedgerImportSheet,
  scan: LedgerImportHeaderScan,
): { rows: LedgerImportCellRow[]; blankRows: number; truncated: number; columnErrors: string[] } {
  const grid = Array.isArray(sheet.grid) ? sheet.grid : [];
  const out: LedgerImportCellRow[] = [];
  let blankRows = 0;
  let truncated = 0;
  const cols = scan.columns;
  /**
   * **列级**错误（整个文件只有一句）。
   * 「缺「相关人」列」按行报会变成 800 行一模一样的红字，用户以为要改 800 处，
   * 而真相是表头少了一列 —— 这种"一句话说清、只需要改一处"的问题不该逐行刷屏（审查 §5-6）。
   */
  const columnErrors: string[] = [];
  if (cols.party === -1) {
    columnErrors.push(
      '这份文件没有「相关人」列：每笔都要有资金相关人（钱付给谁 / 谁付给我）。请补上这一列再导，或下载模板照列名填',
    );
  }

  for (let i = scan.headerRow + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!Array.isArray(row)) continue;
    const values: Partial<Record<LedgerImportColumnKey, unknown>> = {};
    for (const def of LEDGER_IMPORT_COLUMNS) values[def.key] = cellAt(row, cols[def.key]);
    const hasAny = LEDGER_IMPORT_COLUMNS.some((d) => cellText(values[d.key]) !== '') ||
      (values.bizDate instanceof Date);
    if (!hasAny) {
      blankRows++;
      continue;
    }
    if (out.length >= LEDGER_IMPORT_MAX_ROWS) {
      truncated++;
      continue;
    }

    const cells: Partial<Record<LedgerImportColumnKey, string>> = {};
    for (const def of LEDGER_IMPORT_COLUMNS) {
      const raw = values[def.key];
      cells[def.key] = raw instanceof Date ? '' : cellText(raw);
    }

    const errors: string[] = [];
    const warns: string[] = [];

    const date = parseImportDateCell(values.bizDate);
    if (date.error) errors.push(date.error);
    else if (!date.text && cols.bizDate !== -1) errors.push('发生日期必填');

    const kind = parseImportKindCell(values.kind);
    if (kind.error) errors.push(kind.error);
    else if (!kind.kind) {
      errors.push(
        cols.kind === -1
          ? '这份文件没有「方向」列：每笔都要标明是收入还是支出（下载模板补上这一列）'
          : '方向必填（收入 / 支出）',
      );
    }

    const amount = parseImportAmountCell(values.amount);
    if (amount.error) errors.push(amount.error);
    else if (!amount.cents) errors.push('金额必填');
    // 自动取整必须念出来：账上的数字和文件里的数字不一样，用户有权在预览里就看出来
    if (amount.rounded) warns.push(amount.rounded);

    const basis = parseImportBasisCell(values.basis);
    if (basis.error) errors.push(basis.error);
    const scope = parseImportScopeCell(values.scope);
    if (scope.error) errors.push(scope.error);

    const alloc = parseImportAllocCell(values.allocShops);
    errors.push(...alloc.errors);
    if (alloc.tokens.length > ALLOC_MAX_SHOPS) {
      errors.push(`分摊店铺写了 ${alloc.tokens.length} 家，超出 ${ALLOC_MAX_SHOPS} 家：请确认分隔符用的是 、 , ; | /`);
    }

    const party = cellText(values.party);
    // 整列缺失交给上面的 columnErrors（一句说清）；只有"列在、这格空着"才逐行报
    if (!party && cols.party !== -1) {
      errors.push('相关人必填：钱付给谁 / 谁付给我（没有就先在「记账 › 相关人」建好）');
    }
    if (cellText(values.settle)) {
      warns.push('「结算状态」这一列导入不生效：结没结清在「往来」页签里做，会连带改余额与结算单');
    }

    out.push({
      rowNo: i + 1,
      cells,
      bizDate: date.text,
      kind: kind.kind,
      amountCents: amount.cents,
      amountRounded: !!amount.rounded,
      party,
      category: cellText(values.category),
      shop: cellText(values.shop),
      alloc: alloc.tokens,
      hasAllocPct: alloc.hasPct,
      basis: basis.basis,
      scope: scope.scope,
      settle: cellText(values.settle),
      note: cellText(values.note),
      errors,
      warns,
    });
  }
  return { rows: out, blankRows, truncated, columnErrors };
}

// ---------------------------------------------------------------------------
// ③ 名字对 id + 摊钱 + 查重
// ---------------------------------------------------------------------------

/**
 * 一条名字解析结果（由主进程 `ledger-name-resolve` 产出，本层只消费）。
 *
 * 类型直接复用 IPC 边界那一份（`src/types.ts`）：这里再声明一遍就会出现
 * "主进程返回的形状与本层假设的形状各自演化"，而两边都编译得过。
 */
export type LedgerRefResolution = LedgerNameHit;

/** 三轴的名字结论 —— 与 `ledger-name-resolve` 的返回同一形状（宿主原样送过来） */
export type LedgerImportRefs = LedgerNameResolveResult;

export interface LedgerImportRevenue {
  /** 期间 `YYYY-MM` → 营收（复用 `ledgerRevenue.revenueByShopId` 的产物，本层不重算） */
  byPeriod: Record<string, LedgerRevenue>;
}

export interface LedgerImportContext {
  refs: LedgerImportRefs;
  /** 期间 → 当期可分摊店铺 id（`ledgerEligibleShops` 的 eligible 项；「全部」按此展开） */
  eligibleByPeriod: Record<string, number[]>;
  revenue: LedgerImportRevenue;
  /** 店铺 id → 店名（分摊逐笔展示用；只有展示，不参与判定） */
  shopNameById: Record<number, string>;
  /** 库里已有条目的指纹（查重用；见 `ledgerEntryFingerprint`） */
  knownFingerprints?: readonly string[];
}

/** 解析前需要问宿主查哪些名字（去重、去空） */
export function collectImportNameLookups(rows: readonly LedgerImportCellRow[]): {
  party: string[];
  category: string[];
  shop: string[];
} {
  const p = new Set<string>();
  const c = new Set<string>();
  const s = new Set<string>();
  for (const r of rows) {
    if (r.party) p.add(r.party);
    if (r.category) c.add(r.category);
    if (r.shop) s.add(r.shop);
    for (const t of r.alloc) if (t.shop) s.add(t.shop);
  }
  return { party: [...p], category: [...c], shop: [...s] };
}

/** 解析前需要问宿主取哪些期间：「全部」展开要可摊店铺，`按营收占比` 要营收 */
export function collectImportPeriodNeeds(rows: readonly LedgerImportCellRow[]): {
  eligiblePeriods: string[];
  revenuePeriods: string[];
} {
  const eligible = new Set<string>();
  const revenue = new Set<string>();
  for (const r of rows) {
    if (!r.bizDate) continue;
    const period = periodOf(r.bizDate);
    if (r.alloc.some((t) => t.all)) eligible.add(period);
    if (r.basis === 'revenue') revenue.add(period);
  }
  return { eligiblePeriods: [...eligible], revenuePeriods: [...revenue] };
}

/**
 * 一条账目的"同一条"判据。
 *
 * 取**事实值**（日期/方向/金额/相关人/科目/归属或分摊签名/备注），刻意不取 id、也不取录入时间：
 * 重复导入同一份文件是最常见的误操作，而它产出的每一行 id 都不同 —— 只有这些业务字段能认出"同一笔"。
 * 分摊签名一起算进去：同日期同金额但摊给不同店，是两笔真的账。
 *
 * 相关人/科目还是"库里没有、待新建"时没有 id：此时用**名字**占位，
 * 否则"同一天同一笔钱给张三"和"给李四"会因为两个 id 都是 0 而被判成同一笔（把真账标成重复）。
 * 名字只在 id 缺位时参与，所以库里已有条目的指纹形态不变。
 *
 * ⚠️ 文件内部查重与库内查重**必须用同一个函数**，否则一边算得出、一边算不出，
 * 用户会看到"这行明明和上面那行一样，为什么只标了一个"。
 */
export function ledgerEntryFingerprint(input: {
  bizDate: string;
  kind: LedgerKind | '';
  amountCents: number;
  partyId: number;
  categoryId: number;
  scope: LedgerScope | '';
  shopId: number;
  note: string;
  allocations?: readonly AllocationRow[];
  /** 待新建的相关人/科目名字（id 为 0 时代入指纹；有 id 时忽略） */
  newPartyName?: string;
  newCategoryName?: string;
}): string {
  const allocSig = (input.allocations ?? [])
    .slice()
    .sort((a, b) => a.shopId - b.shopId)
    .map((a) => `${a.shopId}:${a.amountCents}`)
    .join(',');
  const partySig =
    input.partyId > 0 ? String(input.partyId) : `new:${String(input.newPartyName ?? '').trim()}`;
  const categorySig =
    input.categoryId > 0 ? String(input.categoryId) : `new:${String(input.newCategoryName ?? '').trim()}`;
  return [
    input.bizDate,
    input.kind,
    input.amountCents,
    partySig,
    categorySig,
    input.scope,
    input.shopId,
    allocSig,
    String(input.note ?? '').replace(/\s+/g, ''),
  ].join('|');
}

/**
 * 库里已有条目 → 指纹集合（`ctx.knownFingerprints` 的来源；**复用上面同一个函数，不另算一套**）。
 *
 * 两类条目都能算：
 * - `scope='shop'`：分摊行恒为"本店全额"，直接合成，不用查库；
 * - `scope='shared'`：**必须**带 `allocations`（列表请求加 `includeAllocations`），否则跳过 ——
 *   没有分摊签名就算指纹，会把"同额不同摊法"的两笔判成重复（误报比漏报贵得多）。
 *
 * 2026-10-27 之前公共条目整类被跳过（"分摊行不在列表接口里"），于是房租 / 工资这种**按月重复导入**
 * 的类型恰好完全无保护，重复入账后分摊守恒断言查不出来（两边一起翻倍）、体检也全绿（审查 P1-4）。
 *
 * 作废条目不进集合：作废是"这笔不算了"，按同一份文件重记往往正是用户要做的事。
 */
export function ledgerEntryFingerprintsFromRows(rows: readonly LedgerEntryRow[]): string[] {
  const out: string[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r.status !== 'active') continue;
    let allocations: Array<{ shopId: number; amountCents: number; ratioBp: number }>;
    if (r.scope === 'shop') {
      if (!(Number(r.shopId) > 0)) continue;
      // 专属条目落库时主进程写的是「一家店全额」这一行分摊，与解析器预览合成的那份同形状
      allocations = [{ shopId: r.shopId, amountCents: r.amountCents, ratioBp: 10000 }];
    } else if (r.scope === 'shared') {
      if (!Array.isArray(r.allocations) || !r.allocations.length) continue;
      allocations = r.allocations.map((a: { shopId: number; amountCents: number; ratioBp: number }) => ({
        shopId: a.shopId,
        amountCents: a.amountCents,
        ratioBp: a.ratioBp,
      }));
    } else {
      continue;
    }
    out.push(
      ledgerEntryFingerprint({
        bizDate: r.bizDate,
        kind: r.kind,
        amountCents: r.amountCents,
        partyId: r.partyId,
        categoryId: r.categoryId,
        scope: r.scope,
        shopId: r.shopId,
        note: r.note,
        allocations,
      })
    );
  }
  return out;
}

/**
 * 「全选」到底勾哪些行。
 *
 * **疑似重复不参与**（审查 P1-3）：解析层默认勾选已经刻意排除了 `duplicate`，列表上方还写着
 * "N 行像已经记过了（默认没勾）"；全选若把它们一起勾上，去重逻辑的全部意义就被一个按钮抵消了
 * —— 同一份文件导第二次 = 120 行静默重复入账。
 *
 * 需要在"确实要重记"时包含重复行，由界面另给一个显式动作（不藏在这个"全选"里）。
 */
export function pickableImportRowNos(rows: readonly LedgerImportRowResult[]): number[] {
  return rows.filter((r) => r.ok && !r.duplicate).map((r) => r.rowNo);
}

export interface LedgerImportAllocation {
  shopId: number;
  shopName: string;
  amountCents: number;
  ratioBp: number;
}
/** 一行校验完的结果：`ok=false` 不入库（error 级），`warnings` 照入库但要让用户看见 */
export interface LedgerImportRowResult {
  rowNo: number;
  ok: boolean;
  /** 默认勾选 = 合格且不像重复 */
  selected: boolean;
  errors: string[];
  warnings: string[];
  /** 落库入参（`ok` 时字段齐全；不合格时也带已解析到的值，界面据此回显） */
  input: LedgerImportEntryInput;
  allocations: LedgerImportAllocation[];
  /** 相关人 / 科目库里没有：落库时会**新建**（界面必须把这两个名字摆到明面上） */
  newParty: string;
  newCategory: string;
  /** 基准是推出来的（没写「分摊基准」，或分摊店铺带百分比被判成手工比例） */
  basisInferred: boolean;
  /** 文件里的金额超过两位小数、已四舍五入到分（warnings 里有同一句话） */
  amountRounded: boolean;
  /** 与库内已有条目或本文件另一行完全相同 */
  duplicate: boolean;
  fingerprint: string;
  period: string;
  /** 展示 */
  kindText: string;
  amountCents: number;
  partyText: string;
  categoryText: string;
  scopeText: string;
  shopText: string;
  basisText: string;
  note: string;
  cells: Partial<Record<LedgerImportColumnKey, string>>;
}

function refOf(refs: Record<string, LedgerRefResolution>, raw: string): LedgerRefResolution | undefined {
  if (!raw) return undefined;
  return refs[raw] ?? refs[raw.trim()] ?? undefined;
}

/**
 * 店铺"不能参与分摊"时的说法，按**原始状态**字面写。
 *
 * 退店（`exited`）永远走不到这里 —— 它参与分摊，也参与专属记账（主进程 `eligibleShops` 同一条口径）。
 * 之所以要看 `status` 而不是只看 `state`：都是"不能用"，但"已封店"和"已停用"要做的事不一样
 * （一个是平台冻结，一个是自己关的），只说"已停用"会让人去改错地方。
 */
function shopStateLabel(hit: LedgerNameHit): string {
  if (hit.status === 'banned') return '已封店';
  if (hit.status === 'archived') return '已停用';
  return '当前状态不能参与';
}

interface SharedAllocOutcome {
  errors: string[];
  warnings: string[];
  allocations: LedgerImportAllocation[];
  basis: LedgerBasis | '';
  /** 基准是推出来的（文件里没写「分摊基准」） */
  basisInferred: boolean;
}

/**
 * 公共分摊的一行 → 逐店金额。
 *
 * 参与店铺先由名字或「全部」展开成 id，再把基准与权重交给 `computeAllocations`（唯一实现）。
 * 任何一步认不出来都算**这一行**的错误，不带半套参与店铺去摊钱：少一家店的表现是
 * "剩下几家各多摊一点"，而合计仍然等于金额 —— 守恒断言抓不到，事后也查不出来。
 */
function resolveSharedAllocation(
  r: LedgerImportCellRow,
  ctx: LedgerImportContext,
  period: string,
  amountCents: number,
): SharedAllocOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 参与店铺（名 → id；「全部」按当期可摊店铺展开）
  const ids: number[] = [];
  const idSet = new Set<number>();
  let hasAll = false;
  for (const t of r.alloc) {
    if (t.all) {
      hasAll = true;
      continue;
    }
    const hit = refOf(ctx.refs.shop, t.shop);
    if (!hit || hit.state === 'missing') {
      errors.push(`分摊店铺「${t.shop}」不存在：名字要和「基础数据 › 店铺」里的一致`);
      continue;
    }
    if (hit.state === 'archived') {
      errors.push(`分摊店铺「${hit.name}」${shopStateLabel(hit)}：这家店不能摊钱（要摊就先到「基础数据」把它改成启用）`);
      continue;
    }
    if (hit.state === 'ambiguous') {
      errors.push(`分摊店铺「${t.shop}」对应多家店：先在「基础数据」里改名或合并`);
      continue;
    }
    if (idSet.has(hit.id)) {
      errors.push(`分摊店铺「${hit.name}」写了两遍：同一家店两行分摊会被算两次`);
      continue;
    }
    idSet.add(hit.id);
    ids.push(hit.id);
  }
  if (hasAll) {
    const eligible = ctx.eligibleByPeriod[period];
    if (!eligible) {
      errors.push(`「全部」要按 ${period} 当期营业中的店铺摊，但当期店铺没取到：关掉导入弹层重开一次`);
    } else if (!eligible.length) {
      errors.push(`${period} 没有营业中的店铺，「全部」摊不出去：改成手工指定店铺`);
    } else {
      for (const id of eligible) {
        if (idSet.has(id)) continue;
        idSet.add(id);
        ids.push(id);
      }
    }
  }
  if (!ids.length && !errors.length) errors.push('分摊店铺一家都没认出来');

  // 基准：显式写的 > 百分比推断手工 > 平均（第三种要标注"推出来的"，界面说给用户听）
  let basis = r.basis;
  let basisInferred = false;
  if (!basis) {
    basisInferred = true;
    basis = r.hasAllocPct ? 'manual' : 'equal';
  }
  if (basis === 'manual' && !r.hasAllocPct) {
    errors.push('分摊基准是手工比例，但「分摊店铺」里没写百分比：写成 店A=60%、店B=40%');
  }
  if (basis && basis !== 'manual' && r.hasAllocPct) {
    errors.push(
      `「分摊基准」写了${basis === 'revenue' ? '按营收占比' : '平均分摊'}，但分摊店铺带了百分比（那是手工比例）`,
    );
  }

  const allocations: LedgerImportAllocation[] = [];
  if (!errors.length && basis) {
    const pctByShop = new Map<number, number>();
    for (const t of r.alloc) {
      if (t.pct === null) continue;
      const hit = refOf(ctx.refs.shop, t.shop);
      if (hit && hit.state === 'ok') pctByShop.set(hit.id, t.pct);
    }
    const participants: AllocParticipant[] = ids.map((id) => ({
      shopId: id,
      weight: basis === 'manual' ? Math.round((pctByShop.get(id) ?? 0) * 100) : undefined,
    }));

    if (basis === 'revenue') {
      const rev = ctx.revenue.byPeriod[period];
      if (!rev) {
        errors.push(`${period} 的营收没取到，按营收占比摊不了：改用平均分摊，或先在「统计」页把这月订单导进来`);
      } else if (rev.truncated) {
        // 半份数据算出来的占比会把钱摊错 —— 「记一笔」也是这条红线，两条路必须一致
        errors.push(`${period} 的订单太多、取数被截断，营收占比是拿半份订单算的：请改用平均分摊`);
      } else {
        const weights = participantRevenueCents(rev, ids);
        for (let i = 0; i < participants.length; i++) participants[i].weight = weights[i];
      }
    }

    if (!errors.length) {
      try {
        const res = computeAllocations(amountCents, basis, participants);
        const gap = conservationGap(amountCents, res.rows);
        if (gap !== 0) {
          errors.push(`分摊合计与金额对不上（差 ${gap} 分）`);
        } else {
          for (const row of res.rows) {
            allocations.push({
              shopId: row.shopId,
              shopName: ctx.shopNameById[row.shopId] ?? `店铺#${row.shopId}`,
              amountCents: row.amountCents,
              ratioBp: row.ratioBp,
            });
          }
          if (res.fallback) {
            warnings.push(
              `${period} 这几家店当期都没有营收，已改按平均分摊（不然这笔钱会从店铺维度消失）`,
            );
          }
          basis = res.basis;
        }
      } catch (e: unknown) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return { errors, warnings, allocations, basis, basisInferred };
}

/**
 * 名字解析结果 → 逐行校验：把 `refs` 的结论、当期店铺、营收权重喂给 `computeAllocations`。
 *
 * 本函数**不产金额口径**：摊多少钱是 `ledger.ts` 算的，认不出谁是谁是宿主算的。
 */
export function resolveLedgerImportRows(
  rows: readonly LedgerImportCellRow[],
  ctx: LedgerImportContext,
): LedgerImportRowResult[] {
  const known = new Set(ctx.knownFingerprints ?? []);
  const seen = new Map<string, number>();
  const out: LedgerImportRowResult[] = [];

  for (const r of Array.isArray(rows) ? rows : []) {
    const errors = [...r.errors];
    const warnings = [...r.warns];
    const period = r.bizDate ? periodOf(r.bizDate) : '';

    // ---- 相关人 / 科目（库里没有 → 落库时按名字新建，见文件头第一条判据）----
    let partyId = 0;
    let newPartyName = '';
    let partyText = r.party;
    if (r.party) {
      const hit = refOf(ctx.refs.party, r.party);
      if (!hit || hit.state === 'missing') {
        // 名字交给主进程在同一事务里建；这里只标出来，让人有机会在预览里看出"这个人是打错的"
        newPartyName = r.party.trim();
      } else if (hit.state === 'archived') {
        errors.push(`相关人「${hit.name}」已停用：请启用它或改用别人（停用在往来台账里还会继续累计）`);
      } else if (hit.state === 'ambiguous') {
        errors.push(`相关人「${r.party}」匹配到多条记录：请在「记账 › 相关人」里改名区分`);
      } else {
        partyId = hit.id;
        partyText = hit.name;
      }
    }

    let categoryId = 0;
    let newCategoryName = '';
    let categoryText = r.category;
    if (r.category) {
      const hit = refOf(ctx.refs.category, r.category);
      if (!hit || hit.state === 'missing') {
        newCategoryName = r.category.trim();
      } else if (hit.state === 'archived') {
        errors.push(`科目「${hit.name}」已停用：请启用它或换一个`);
      } else if (hit.state === 'ambiguous') {
        errors.push(`科目「${r.category}」匹配到多条记录：请在「记账 › 科目」里改名区分`);
      } else {
        categoryId = hit.id;
        categoryText = hit.name;
        // 「科目类型与收/支方向不一致」主进程也会挡（`upsertEntry`），这里先报是为了让
        // "哪一行错、错在哪"在预览里逐行摊开，而不是整批失败后一条条试。
        if (hit.kind && r.kind && hit.kind !== r.kind) {
          errors.push(
            `科目「${hit.name}」是${hit.kind === 'income' ? '收入' : '支出'}科目，这一笔的方向是${r.kind === 'income' ? '收入' : '支出'}：换一个科目或改方向`,
          );
        }
      }
    }

    // ---- 归属：专属某店 / 公共分摊（两列互斥，且与「归属」列互校）----
    let scope: LedgerScope | '' = r.scope;
    let shopId = 0;
    let shopText = r.shop;
    const hasShop = r.shop !== '';
    const hasAlloc = r.alloc.length > 0;

    if (hasShop && hasAlloc) {
      errors.push('同时填了「店铺」和「分摊店铺」：一家店掏钱只填店铺，几家店一起摊只填分摊店铺');
    } else if (hasShop) {
      const hit = refOf(ctx.refs.shop, r.shop);
      if (!hit || hit.state === 'missing') {
        errors.push(`店铺「${r.shop}」不存在：名字要和「基础数据 › 店铺」里的一致`);
      } else if (hit.state === 'ambiguous') {
        errors.push(`店铺「${r.shop}」对应多家店：先在「基础数据」里改名或合并（同名不同店是两本账）`);
      } else {
        shopId = hit.id;
        shopText = hit.name;
      }
      if (scope === 'shared') errors.push('「归属」写了公共，但填的是「店铺」（专属某店）');
      scope = scope || 'shop';
    } else if (hasAlloc) {
      if (scope === 'shop') errors.push('「归属」写了专属，但填的是「分摊店铺」（公共分摊）');
      scope = scope || 'shared';
    } else {
      errors.push('「店铺」和「分摊店铺」至少要填一个：这笔钱是一家店掏，还是几家店一起摊？');
    }

    // ---- 公共分摊：参与店铺 + 基准 + 权重 → `computeAllocations` ----
    const amountCents = r.amountCents;
    let allocations: LedgerImportAllocation[] = [];
    let basis: LedgerBasis | '' = r.basis;
    let basisInferred = false;

    if (scope === 'shared' && hasAlloc && amountCents > 0 && !errors.length) {
      const shared = resolveSharedAllocation(r, ctx, period, amountCents);
      errors.push(...shared.errors);
      warnings.push(...shared.warnings);
      allocations = shared.allocations;
      if (shared.basis) basis = shared.basis;
      basisInferred = shared.basisInferred;
    } else if (scope === 'shop' && shopId > 0 && amountCents > 0) {
      // 专属：主进程自动写"一家店全额"一行分摊。这里只为逐笔展示合成它，**不参与落库**。
      allocations = [{ shopId, shopName: shopText, amountCents, ratioBp: 10000 }];
    }

    // ---- 落库入参 ----
    const input: LedgerImportEntryInput = {
      // Excel 行号随载荷带给主进程：它报错时说的是"第 N 行"，那个 N 必须是**用户表里的行号**，
      // 不能是这批里的第几条（勾选子集 / 跳过不合格行后，两者完全不是一回事，审查 §5-6）
      rowNo: r.rowNo,
      bizDate: r.bizDate,
      kind: r.kind || undefined,
      scope: scope || undefined,
      shopId: scope === 'shop' ? shopId : 0,
      partyId,
      categoryId,
      // id 为 0 的行带名字：主进程在同一事务里找或建（导入自动建人/科目）
      partyName: partyId > 0 ? undefined : newPartyName || undefined,
      categoryName: categoryId > 0 ? undefined : newCategoryName || undefined,
      amountCents: amountCents || undefined,
      basis: scope === 'shared' ? basis || undefined : undefined,
      note: r.note,
      allocations:
        scope === 'shared' && allocations.length
          ? allocations.map((a) => ({ shopId: a.shopId, amountCents: a.amountCents, ratioBp: a.ratioBp }))
          : undefined,
    };

    const fingerprint = ledgerEntryFingerprint({
      bizDate: r.bizDate,
      kind: r.kind,
      amountCents,
      partyId,
      categoryId,
      scope,
      shopId: scope === 'shop' ? shopId : 0,
      note: r.note,
      allocations: allocations.map((a) => ({ shopId: a.shopId, amountCents: a.amountCents, ratioBp: a.ratioBp })),
      newPartyName,
      newCategoryName,
    });

    let duplicate = false;
    if (!errors.length) {
      if (known.has(fingerprint)) {
        duplicate = true;
        warnings.push('和库里已有的一条账目完全相同（日期/方向/金额/相关人/科目/归属/备注都一样）：疑似重复录入，已默认不勾选');
      } else {
        const prev = seen.get(fingerprint);
        if (prev !== undefined) {
          duplicate = true;
          warnings.push(`和本文件第 ${prev} 行完全相同：疑似重复录入，已默认不勾选`);
        } else {
          seen.set(fingerprint, r.rowNo);
        }
      }
    }

    const ok = errors.length === 0;
    out.push({
      rowNo: r.rowNo,
      ok,
      selected: ok && !duplicate,
      errors,
      warnings,
      input,
      allocations,
      newParty: partyId > 0 ? '' : newPartyName,
      newCategory: categoryId > 0 ? '' : newCategoryName,
      basisInferred,
      amountRounded: r.amountRounded,
      duplicate,
      fingerprint,
      period,
      kindText: r.kind === 'income' ? '收入' : r.kind === 'expense' ? '支出' : '',
      amountCents,
      partyText,
      categoryText,
      scopeText: scope === 'shop' ? '专属' : scope === 'shared' ? '公共' : '',
      shopText: scope === 'shop' ? shopText : hasAlloc ? `${allocations.length} 家` : '',
      basisText: basis === 'equal' ? '平均分摊' : basis === 'revenue' ? '按营收占比' : basis === 'manual' ? '手工比例' : '',
      note: r.note,
      cells: r.cells,
    });
  }
  return out;
}

/**
 * 结构化克隆安全的深拷贝：**过 IPC 的对象必须现造**。
 *
 * 为什么需要它：这些结果在界面里躺在 Vue 的 `ref` 里，读出来的每一层（对象、数组、数组元素）
 * 都是 **reactive proxy**，而 `ipcRenderer.invoke` 走结构化克隆 —— proxy 一个都克隆不了，
 * 报错是 `An object could not be cloned.`。它发生在主进程收到任何东西之前，带不上行号、
 * 也说不出哪个字段有问题，用户只能看到一句与业务无关的英文（真机实证：一笔都没进）。
 *
 * **浅拷贝不够**：`{ ...r.input }` 只换了最外层，`allocations` 与它的元素还是代理 ——
 * 实测"只导专属行"碰巧能过（专属行的 `input.allocations` 是 undefined），一旦文件里有公共支出
 * 就整批炸。这种"看文件内容决定成不成"的故障最难查。
 *
 * 刻意**不做字段白名单**：白名单在 preload（`sanitizeLedgerImportEntries`）里已经有一份，
 * 渲染层再抄一份就会出现"新加字段两边不同步 → 静默丢掉"（本仓库已经吃过三次同款亏）。
 * 这里只负责"变成普通对象/标量"，认哪些字段是宿主那层的事。
 */
function toCloneable<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => toCloneable(x)) as unknown as T;
  if (v instanceof Date) return new Date(v.getTime()) as unknown as T;
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) out[k] = toCloneable(src[k]);
    return out as T;
  }
  return v;
}

/** 勾选通过的行 → 批量落库入参（顺序保持文件顺序，出错时"第 N 行"才对得上） */
export function buildLedgerImportPayload(
  results: readonly LedgerImportRowResult[]
): LedgerImportEntryInput[] {
  return results.filter((r) => r.selected && r.ok).map((r) => toCloneable(r.input));
}

// ---------------------------------------------------------------------------
// ④ 模板内容（渲染层算"写什么"，主进程只负责画表存盘）
// ---------------------------------------------------------------------------

export interface LedgerTemplateSheet {
  name: string;
  rows: string[][];
  widths: number[];
}

export interface LedgerTemplateNames {
  parties?: readonly string[];
  expenseCategories?: readonly string[];
  incomeCategories?: readonly string[];
  shops?: readonly string[];
}

/**
 * 下载模板的三个表：数据表（**只有表头**）+ 填写说明 + 已有名称。
 *
 * 为什么不塞示例行：示例行和用户的数据行形状完全一样，忘了删就是一笔假账，
 * 而它日期是过去的、金额是整数，事后极难从一堆真账里认出来。示例放「填写说明」里。
 * 「已有名称」这一表是为了让用户知道"我文件里的名字，库里到底叫什么" —— 相关人/科目
 * 对不上会自动新建（容易多出个错名字），店铺对不上则整行报错（店铺不新建）。
 */
export function buildLedgerTemplateSheets(names: LedgerTemplateNames = {}): LedgerTemplateSheet[] {
  const cols = LEDGER_TEMPLATE_COLUMNS;
  const dataSheet: LedgerTemplateSheet = {
    name: '导入模板',
    rows: [cols.map((c) => c.label)],
    widths: cols.map((c) => Math.max(12, c.label.length * 2 + 6)),
  };

  const guide: LedgerTemplateSheet = {
    name: '填写说明',
    rows: [
      ['列', '必填', '怎么填', '例子'],
      ...cols.map((c) => [c.label, c.required ? '必填' : '可空', c.hint, c.example]),
      [],
      ['几条规矩'],
      ['1', '', '金额一律填正数，收还是支由「方向」列决定；负数会被当成填错。', ''],
      ['2', '', '一家店掏钱 → 只填「店铺」；几家店一起摊 → 只填「分摊店铺」（写「全部」= 当期营业中的店都摊）。', ''],
      ['3', '', '「分摊店铺」带百分比 = 手工比例，合计必须正好 100%；不带百分比时默认平均分摊。', ''],
      ['4', '', '相关人 / 科目 库里没有会自动新建（新建的相关人类型是「其他」，导完可在「记账 › 相关人」改）；店铺必须先登记，对不上会整行报错。', ''],
      ['5', '', '导入只新增账目，不会改动已有的；重复导入同一份文件时，完全相同的行会被标成"疑似重复"并默认不勾选。', ''],
    ],
    widths: [14, 8, 76, 26],
  };

  const parties = Array.from(names.parties ?? []);
  const expenseCats = Array.from(names.expenseCategories ?? []);
  const incomeCats = Array.from(names.incomeCategories ?? []);
  const shops = Array.from(names.shops ?? []);
  const header = ['相关人', '支出科目', '收入科目', '店铺'];
  const body: string[][] = [];
  const longest = Math.max(parties.length, expenseCats.length, incomeCats.length, shops.length);
  for (let i = 0; i < longest; i++) {
    body.push([parties[i] ?? '', expenseCats[i] ?? '', incomeCats[i] ?? '', shops[i] ?? '']);
  }
  const namesSheet: LedgerTemplateSheet = {
    name: '已有名称',
    rows: [header, ...(body.length ? body : [['（还没有相关人）', '（还没有支出科目）', '（还没有收入科目）', '（还没有店铺）']])],
    widths: [24, 20, 20, 24],
  };

  return [dataSheet, guide, namesSheet];
}
