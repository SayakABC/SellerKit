// electron/aeMoney.ts
// 「采集订单（速卖通利润追踪）」的**金额/分摊/规格**纯函数层（零依赖：不碰 better-sqlite3 / electron）。
//
// 为什么单独成文件（与 `shopName.ts` / `orderMoney.ts` / `shopSku.ts` 同理由）：`ae-db.ts` / `order-db.ts` /
// `shop-item-db.ts` 等 DB 层依赖 Electron 的 Node ABI，进不了 vitest；而"行收入怎么分摊到行""退款科目怎么算"
// "规格串怎么解析"是这条链上唯一有正确性风险的东西，摘成零依赖模块后才能被 `tests/aeMoney.spec.ts` 直接覆盖。
//
// ⚠️ 它是**单一口径源**：`ae-db.upsertOrderBatch`（采集落订单主干 `oi_orders`）与 `order-db` 的订单投影、
// `shop-item-db` 的规格解析都必须调这里的函数 —— 几处各写一份分摊规则，就会让"同一批采集订单"在
// 不同页面显示不同数（这正是重构要消灭的"多套"）。
//
// 口径（沿用 `docs/features/PROFIT_TRACKER.md` §4，本轮把"按 qty 近似"细化为"按行金额占比"）：
//   收入（原币）= 商品金额 + 买家付运费 − 退款/纠纷类科目
//   行收入（原币）= 行商品金额 ÷ 订单商品金额合计 × 订单收入；**行金额合计为 0 时回落按 qty 占比**
//   （行金额是真值，qty 只是"金额缺失时的近似"——原来一律按 qty 会把「1 件 198 元 + 1 件 12 元」摊成各半）

export {};

// 色名比对键与归色链路**共用一份**（`colorAliasKey`：折叠大小写/空白、全角转半角）。
// 这里只是拿它做"两个写法算不算同一个色"的去重，不代表任何语义判断 —— 见 `colorAlias.ts` 头注。
import { colorAliasKey } from './colorAlias';

/** 退款/纠纷类费用科目 = 收入扣减（其余科目进费用侧）。**唯一一份**（ae-db / order-db 都从这里取） */
export const AE_DEDUCTION_CATEGORIES: ReadonlySet<string> = new Set([
  'refund',
  'dispute',
  'refund_amount',
]);

/** 订单收入（原币）= 商品金额 + 买家付运费 − 退款 */
export function orderIncomeCcy(input: {
  goodsAmount?: unknown;
  shippingIncome?: unknown;
  deductionAmount?: unknown;
}): number {
  return num(input?.goodsAmount) + num(input?.shippingIncome) - num(input?.deductionAmount);
}

/** 一行采集明细（订单行的最小投影） */
export interface AeLineShareInput {
  qty?: unknown;
  goodsAmount?: unknown;
}

/**
 * 把订单收入按行分摊（原币）。
 *
 * 规则：**优先按行商品金额占比**；行金额合计 ≤ 0（脏数据/未采集金额）时回落**按 qty 占比**；
 * 两者都不可用时平分（保证 Σ = 订单收入，不吞钱也不生钱）。
 * @returns 与入参等长的行收入数组（Σ = `incomeCcy`）
 */
export function lineIncomeShares(lines: readonly AeLineShareInput[] | null | undefined, incomeCcy: unknown): number[] {
  const list = Array.isArray(lines) ? lines : [];
  const income = num(incomeCcy);
  if (!list.length) return [];
  const goods = list.map((l) => num(l?.goodsAmount));
  const goodsSum = goods.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (goodsSum > 0) return goods.map((g) => (income * (g > 0 ? g : 0)) / goodsSum);
  const qtys = list.map((l) => Math.max(0, num(l?.qty)));
  const qtySum = qtys.reduce((a, b) => a + b, 0);
  if (qtySum > 0) return qtys.map((q) => (income * q) / qtySum);
  const even = income / list.length;
  return list.map(() => even);
}

/**
 * 采集来的规格串 → 颜色 / 尺码。
 *
 * 实测写法（本机库 101 单）：`Picture color+XXXL+China Mainland`（`+` 分隔的「颜色+尺码+发货地」），
 * 也见 `Color:Red;Size:L`。解析**只认能确定的**：认不出就返回空串（由上层标缺口，不猜）。
 */
export function parseSkuProps(raw: unknown): { color: string; size: string; shipsFrom: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { color: '', size: '', shipsFrom: '' };
  // 形式一：`Color:Red;Size:L` / `Size:L,Color:3`
  const kv = new Map<string, string>();
  for (const part of s.split(/[;；,，]/)) {
    const m = /^\s*([A-Za-z ]+?)\s*[:：]\s*(.+?)\s*$/.exec(part);
    if (m) kv.set(m[1].trim().toLowerCase(), m[2]);
  }
  const color = kv.get('color') ?? kv.get('colour') ?? '';
  const size = kv.get('size') ?? '';
  if (color || size) return { color, size, shipsFrom: kv.get('ships from') ?? '' };
  // 形式二：`+` 分隔（速卖通采集帧）：颜色+尺码+发货地 —— 尺码可辨认（S/M/L/XL/XXL/数字…）
  const parts = s.split('+').map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const sizeIdx = parts.findIndex((p) => /^(\d{2,3}|[XSML]{1,3}L?|XXXL|XXL|XL|XS|S|M|L)$/i.test(p));
    const shipsIdx = parts.findIndex((p) => /china|united states|spain|russia/i.test(p));
    const size = sizeIdx >= 0 ? parts[sizeIdx] : '';
    const shipsFrom = shipsIdx >= 0 ? parts[shipsIdx] : '';
    const color = parts.filter((_, i) => i !== sizeIdx && i !== shipsIdx).join(' ') || '';
    return { color, size, shipsFrom };
  }
  return { color: '', size: '', shipsFrom: '' };
}

// ─────────────────────────────────────────── 报表规格串 → 平台色名（2026-10-20）

/**
 * 报表里可能承载**规格串**的列名族（外层按"具体 → 宽泛"逐条试）。
 * 实测（本机库 51 单）承载位置是「产品信息」，正文形如：
 *   `【1】<标题>\n(产品属性:Color:5,Size:5XL,Ships From:China Mainland)\n(产品数量:1 piece)`
 */
const PROP_TEXT_KEYS: readonly RegExp[] = [/产品信息/, /商品信息/, /规格/, /属性/, /sku\s*props/i];
/** 单独的「颜色」列名族 —— 有就以它为准（一列一值，天然没有歧义） */
const COLOR_COL_KEYS: readonly RegExp[] = [/^颜色$/, /^商品颜色$/, /^color$/i, /^colour$/i];
/** 色名长度上限（与 `shop-db` 的字段上限同量级；防一条脏数据把列撑爆） */
const MAX_COLOR_LEN = 40;

/**
 * 一段规格串里出现的**所有** `Color:<值>`。
 *
 * 两种写法都见过：`Color:5,Size:5XL`（报表）与 `Size:XL,Color:5`（属性顺序不固定）。
 * 只认"带冒号的键值"，**不认** `Picture color+XXXL+China Mainland` 那种 `+` 分隔串
 * （那是采集帧的格式，由 `parseSkuProps` 负责，强行兼容会让两条口径混在一起）。
 *
 * 值截到 `,` `;` `)` 或换行 —— 后面紧跟的通常是 `Size:` 或收尾括号。
 */
export function propsColorTokens(text: unknown): string[] {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const out: string[] = [];
  for (const m of s.matchAll(/(?:colour|color)\s*[:：]\s*([^,;，；)）\n\r]+)/gi)) {
    const v = String(m[1] ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * 报表一行 → **平台色名**（`5` / `Khaki` / `Picture color4`）。定不出就返回 `''`。
 *
 * 为什么需要（真库取证 2026-10-20）：订单报表**没有颜色列**，颜色被塞在「产品信息」的
 * `(产品属性:Color:5,...)` 里 —— 于是 `oi_order_items.color` 全空、归款只能靠"订单图 → 采集色图"
 * 反查。而采集快照没覆盖到的商品（本机 51 单里 44 单）就全部落到占位色「未分类」：
 * **不同颜色的订单长得一模一样**，拣货单上根本分不出该拿哪件（这是发错货的直接来源）。
 * 规格串里那串本来就是平台色名 —— 取出来既不用看图，也不依赖采集过。
 *
 * 三条纪律：
 *   · 一单**多个颜色**（真库有 2 单：一张订单含 4 个 SKU 行、两种颜色）⇒ 返回 `''`。
 *     "取第一个"就是静默错色，宁可留给人工（占位色至少是诚实的"未定"）。
 *   · 有独立「颜色」列时以列值为准（一列一值，不存在歧义）。
 *   · 不做"像不像颜色"的校验（同 `normalizeSkuSize` 的纪律）：`1..15` 这种纯编号是**正当**的
 *     平台色名，黑名单式校验只会把它误伤掉且不报错。
 *
 * @param rawFields 订单原始字段（`oi_order_items.raw_fields` 的 JSON 对象）
 */
export function parseOrderPropsColor(rawFields: Record<string, unknown> | null | undefined): string {
  const entries = Object.entries(rawFields ?? {});
  // ① 独立的颜色列：报表/采集帧都可能给（`颜色` / `color`）
  for (const re of COLOR_COL_KEYS) {
    for (const [k, v] of entries) {
      if (!re.test(k)) continue;
      const s = typeof v === 'string' ? v.trim() : '';
      if (s) return s.slice(0, MAX_COLOR_LEN);
    }
  }
  // ② 规格串里的 `Color:<值>`：按等值（大小写/空白折叠）去重后再判唯一性
  const seen = new Map<string, string>();
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || !v) continue;
    if (!PROP_TEXT_KEYS.some((re) => re.test(k))) continue;
    for (const tok of propsColorTokens(v)) {
      const key = colorAliasKey(tok);
      if (key && !seen.has(key)) seen.set(key, tok);
    }
  }
  if (seen.size !== 1) return ''; // 0 = 没有；>1 = 一单多色 ⇒ 色不可定
  return [...seen.values()][0].slice(0, MAX_COLOR_LEN);
}

/**
 * 报表一行 → **这一行买了几件**（`(商品数量:1 piece)` / `(产品数量:2 piece)`）。取不到返回 `null`。
 *
 * 为什么主进程也需要它（2026-10-20）：件数原先是**只在渲染层**现算的（`src/lib/orderCost.resolveQty`），
 * 主进程的拿货缺口 SQL 拿不到，只能 `COUNT(*)` 按**行数**算需求 —— 一单买 2 件时需求 1、已拿 2，
 * `missing = -1` 后被整行丢出缺口（漏货，且不报错）。把件数落到 `oi_order_items.qty` 才能让两侧同口径。
 *
 * ⚠️ 与 `src/lib/orderRowSplitter.parseRowQty` **必须逐字同义**（同一批行不能两边算出不同件数）：
 * 单一口径靠 `tests/orderQtyParity.spec.ts` 双向比对守住，改一处就会红。
 *
 * 两条"取不到"（都返回 null，绝不给 1）：
 *   · 这一列仍留着**多块原文**（`【1】…【2】…`，拆行没替换）⇒ "这块是哪件"无从判定；
 *   · 该列压根没有（非速卖通格式）。
 * 刻意**不用「产品数量」那一列**：拆行后它仍是整行的值，拿它会把 N 件拆出的每行都按 N 件算。
 */
export function parseOrderQty(rawFields: Record<string, unknown> | null | undefined): number | null {
  const entries = Object.entries(rawFields ?? {});
  let text = '';
  for (const [k, v] of entries) {
    if (!ITEM_INFO_KEYS.test(k)) continue;
    const s = typeof v === 'string' ? v.trim() : '';
    if (s) {
      text = s;
      break;
    }
  }
  if (!text) return null;
  // 多块原文 = 这段文本不属于某一件（与渲染层 `parseInfoBlocks(text).length >= 2` 同义）
  if ((text.match(/【\d+】/g) ?? []).length >= 2) return null;
  for (const re of QTY_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) && n >= 1 && n <= MAX_LINE_QTY ? n : null;
  }
  return null;
}

/** 与 `src/lib/orderRowSplitter` 的常量同值；改这里必须同步那边（parity 用例会红） */
const ITEM_INFO_KEYS = /产品信息|商品信息|产品名称|商品名称|产品详情|商品详情/i;
const QTY_PATTERNS: RegExp[] = [/商品数量\s*[:：]\s*(\d+)/, /产品数量\s*[:：]\s*(\d+)/];
const MAX_LINE_QTY = 999;

/**
 * 采集来的尺码 → 标准码（把卖家塞在尺码字段里的**修饰**剥掉）。
 *
 * 2026-10-17 真库取证（8 个商品 / 546 条 SKU），脏值只有三类：
 *   · 体重区间后缀 `XL 60-65kg` `S 35-40kg` `7XL 105-115kg`（10 种 × 7 色 = 70 条）
 *   · 版型前缀 `Asian size XXXL` `Asian size 4XL`（6 种 × 6 色 = 36 条）
 *   · 无数字的括号补注 `XS（old）`（全角括号，14 条）
 * 合计 120 条。剥完都是合法码（S/M/L/…/7XL/4XL），且**无一与本商品已有的纯码撞列**
 * （回填实测：4 个受害商品的列数 12/8/8/9 一条不变，只是列头变干净）。
 * 所以这里是**提取**而不是丢弃：真按"剔除整行"做，84 行那款只剩 14 行、48 行那款只剩 6 行
 * （带修饰的码就是它全部的码），用户会以为漏采了。
 *
 * 三条保守纪律（都是为了不制造"静默丢数据"）：
 *   1. **只剥已知修饰**，绝不校验"像不像尺码"—— 正当尺码体系无穷（70B / 2T / 28W / 均码），
 *      黑名单式校验迟早误伤；被误伤的码会从矩阵里消失，且不报错。
 *   2. **括号里含数字就不剥**：`S (2-3 years)` 那个区间正是童装用来区分变体的东西，
 *      剥掉会把两个变体并成一格（合并 = 静默少一条 SKU）。
 *   3. 剥完为空 / 输入本来干净 ⇒ 原样返回（幂等：界面改过的值再走一遍也不会变）。
 */
export function normalizeSkuSize(raw: unknown): string {
  const src = typeof raw === 'string' ? raw : '';
  if (!src.trim()) return '';
  // 全角**字母/数字** → 半角（`２ＸＬ` 实测出现过）。只动字母数字：全角括号在中日文里是正常排版，
  // 转成半角等于改用户看到的形态（`M（4-5岁）` 会变成 `M(4-5岁)`），而剥括号的正则两种都认。
  let s = src.replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  s = s.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
  const before = s;
  // ① 版型 / 显式前缀：`Asian size XXXL` → `XXXL`；`Size: L` → `L`
  //    顺序有讲究：先剥 `asian size` 这种两词前缀，否则会剩个 `asian`
  s = s.replace(/^(?:asian|european|eu|us|uk)\s+size\s*[:：]?\s*/i, '');
  s = s.replace(/^(?:size|尺码|码数)\s*[:：]\s*/i, '');
  s = s.replace(/^(?:size|尺码|码数)\s+/i, '');
  // ② 无数字的括号补注：`XS（old）` → `XS`（含数字的留住 —— 见纪律 2）
  s = s.replace(/[(（[【][^)）\]】]*[)）\]】]/g, (m) => (/\d/.test(m) ? m : ' '));
  // ③ 带重量/长度单位的区间后缀：`XL 60-65kg` → `XL`
  s = s.replace(/\s*\d+(?:\.\d+)?\s*[-~–—]\s*\d+(?:\.\d+)?\s*(?:kg|公斤|斤|g|lb|lbs|cm|mm|inch(?:es)?)/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  // 剥空 = 原文本身就是一段修饰（如 `(old)`）：宁可保留脏值，也不制造"没有尺码"
  if (!s) return before;
  // 纯 X/S/M/L 组合统一大写：`xxl` 与 `XXL` 必须是同一列（否则矩阵里两列同码）
  if (/^\d{0,2}[xsml]{1,6}$/i.test(s)) s = s.toUpperCase();
  return s;
}

/**
 * 原币金额 × 汇率 → **分**（CNY 整数）。汇率缺失/非正 → `null`（**不要折成 0**：
 * 0 会让"缺汇率"看起来像"这笔钱是零"，与 `orderMoney` 的空值纪律一致）。
 */
export function toCentsCny(amountCcy: unknown, rateToCny: unknown): number | null {
  const amount = num(amountCcy);
  const rate = num(rateToCny);
  if (!Number.isFinite(amount) || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(amount * rate * 100);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}