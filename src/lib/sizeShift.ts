// src/lib/sizeShift.ts
// 「亚洲款加码」的**纯计算层**：把订单原文尺码换算成**拿货尺码**（下单 L → 拿 XL）。
//
// 业务口径（只改一条，别扩散）：
//   · 只有**拿货侧**的尺码被改写 —— 需求聚合、拣货清单、拿货单明细、已拿抵扣、导出；
//   · `oi_order_items.size`（订单原文）、订单利润、发货台、客户可见内容**一个字都不动**；
//   · 偏移是**款级**的（同一款所有色同偏移），配置权威在 `pl_size_shift.shift`。
//
// 为什么单独一层：尺码链（字符串 → 下一个码）是这条链上唯一有正确性风险的部分 ——
// 数字码 38 的下一个码是 40 还是 39、`3XL` 与 `XXXL` 是不是同一个码、最大码再加码算什么，
// 全都是"猜错不会报错、只是拿错货"的判断。摘成纯函数才能被 vitest 直接钉住。
//
// 三条不变量：
//   ① **认不出就不动**（`known=false`）：`F` / `均码` / `170/92A` 这类码不参与换算，
//      原样保留并计数 —— 静默当成"加好了"会让用户按错码拿货，比不加更糟；
//   ② **超界封顶**（`clamped=true`）：最大码再加码 = 最大码，并把"被封顶"报出去
//      （多个下单码会合并到同一个拿货码，界面必须说清，否则看起来像算漏）；
//   ③ **幂等**：同样的输入两次换算结果一致；`shift=0` 时返回**原串**（连大小写都不改）。

/** 允许的单款最大偏移（业务现状 0…+3；负数留给"欧美款偏大要减码"，默认界面不开放） */
export const MAX_SIZE_SHIFT = 3;

/**
 * 界面下拉的**可选项唯一权威**。
 *
 * 为什么放这里而不是各自写死：幅度是"按客户反馈反复调"的量（+1 不够就 +2），将来很可能
 * 追加"−1 减码"或"+4"。两个下拉各写一遍 4 个 `<option>`，加一个档位就必然漏一处 ——
 * 漏的那处**不会报错**，只是那一边永远选不到新档位。
 */
export const SIZE_SHIFT_OPTIONS = [
  { value: 0, label: '不加码' },
  { value: 1, label: '+1 码' },
  { value: 2, label: '+2 码' },
  { value: 3, label: '+3 码' },
] as const;

/**
 * 字母码序（规范写法）。`2XL` / `3XL` 是 `XXL` / `XXXL` 的同义写法，
 * **不单列一项** —— 列成两项会让 `2XL` 的"下 2 码"落到 `XXXL` 上（同一码跳两格）。
 */
const LETTER_SEQ = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL', '6XL'];

/** 数字码在**没有尺码链**时的步长（服装 38 的下一个码是 40，不是 39） */
export const NUMBER_SIZE_STEP = 2;

/** 尺码归一：去空格、转大写、全角转半角（只用于**定位**，输出仍按原写法风格） */
export function normalizeSize(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toUpperCase();
}

/** 归一后的字母码 → 在 `LETTER_SEQ` 里的下标；不是字母码返回 -1 */
function letterIndex(norm: string): number {
  const direct = LETTER_SEQ.indexOf(norm);
  if (direct >= 0) return direct;
  const m = /^([2-6])XL$/.exec(norm);
  if (m) {
    const n = Number(m[1]);
    // 2XL ≡ XXL、3XL ≡ XXXL、4XL 及以上本来就是 `4XL` 写法
    const alias = n === 2 ? 'XXL' : n === 3 ? 'XXXL' : `${n}XL`;
    return LETTER_SEQ.indexOf(alias);
  }
  return -1;
}

/**
 * 按**原写法风格**输出目标码：原码是 `2XL/3XL` 这种数字写法时，目标落在 XXL/XXXL 上
 * 也用数字写法（`2XL`→`3XL`），否则 `2XL` 加一码会变成 `XXXL` —— 同一个码换了写法，
 * 拿货台账（按文本作键）就对不上了。
 */
function styleOf(norm: string, target: string): string {
  if (!/^[23]XL$/.test(norm)) return target;
  if (target === 'XXL') return '2XL';
  if (target === 'XXXL') return '3XL';
  return target;
}

/** 一次换算的结果 */
export interface ShiftSizeOutcome {
  /** 换算后的码；认不出 / 无偏移时 = 原串 */
  size: string;
  /** 是否真的变了（`false` 表示原样返回） */
  changed: boolean;
  /** 码可判定（字母码 / 数字码 / 在给定尺码链里） */
  known: boolean;
  /** 撞到码段边界被夹住（最大码再加码 / 最小码再减码） */
  clamped: boolean;
}

/**
 * 单码换算。
 *
 * `chain` = 该款的**码链**（升序，通常来自该款 SKU 矩阵 / 历史订单里出现过的码）。
 * 有链时**按位置**移位（`38` 后一个码是不是 `40` 由链说话，不靠猜），链能覆盖
 * `170/92A` 这类无法用字典推断的码；没链时回落到字母码表 / 数字码步长。
 */
export function shiftSize(
  size: unknown,
  shift: unknown,
  chain?: string[] | null
): ShiftSizeOutcome {
  const raw = String(size ?? '');
  const n = Math.trunc(Number(shift) || 0);
  if (!raw.trim() || n === 0) return { size: raw, changed: false, known: true, clamped: false };

  const norm = normalizeSize(raw);

  // ① 先认该款的码链（位置法：对任意码写法都成立）
  const list = Array.isArray(chain) ? chain.filter((s) => String(s ?? '').trim()) : [];
  if (list.length > 1) {
    const idx = list.findIndex((s) => normalizeSize(s) === norm);
    if (idx >= 0) {
      const target = Math.min(list.length - 1, Math.max(0, idx + n));
      const out = String(list[target]);
      return { size: out, changed: out !== raw, known: true, clamped: target !== idx + n };
    }
  }

  // ② 字母码
  const li = letterIndex(norm);
  if (li >= 0) {
    const target = Math.min(LETTER_SEQ.length - 1, Math.max(0, li + n));
    const out = styleOf(norm, LETTER_SEQ[target]);
    return { size: out, changed: out !== raw, known: true, clamped: target !== li + n };
  }

  // ③ 数字码（38 → 40）：步长按行业惯例 2，不加"上限"（数字码没有封顶概念，超了照写）
  if (/^\d+(\.\d+)?$/.test(norm)) {
    const num = Number(norm);
    const out = String(num + n * NUMBER_SIZE_STEP);
    return { size: out, changed: out !== raw, known: true, clamped: false };
  }

  // ④ 认不出：**不动**
  return { size: raw, changed: false, known: false, clamped: false };
}

/** 参与换算的行只需要这几列（结构上与 `PickingRowProjection` 兼容，便于直接传投影行） */
export interface SizeShiftRowLike {
  styleCode?: unknown;
  size?: unknown;
}

/**
 * 单款的加码明细（**界面要的是"哪几款"，不是一个数**）。
 *
 * 为什么必须有这一层：只报"3 款已加码"时，用户没法核对是不是**想加的那 3 款** ——
 * 尤其行内下拉是逐款色各一个，改了 A 忘了 B 时，顶部那个数字照样说得通。
 */
export interface SizeShiftStyleStat {
  styleCode: string;
  /** 该款的偏移（+1…+3；负数留给减码） */
  shift: number;
  /** 该款参与换算的行数（含封顶与认不出的行 —— 它们**也是**这批货的一部分） */
  rows: number;
  /** 其中码真的变了的行数 */
  changedRows: number;
  /** 撞到码段边界被封顶的行数 */
  clampedRows: number;
  /** 尺码认不出的行数（这些行**没加码**，照原码拿） */
  unknownRows: number;
}

/** 行级换算的统计（界面按它出"本批 N 款已加码 / M 行被封顶 / K 行认不出"） */
export interface SizeShiftStats {
  /** 实际改了码的**行数** */
  shiftedRows: number;
  /**
   * 参与加码的**款数**（去重）。
   * ⚠️ 口径是"这批货里偏移 ≠ 0 的款"，**不是**"有行真的改了码的款"：
   * 整款都撞到最大码（封顶）或整个款只有 `F`/均码时，一个码都没变，但它**确实被设成了加码款**，
   * 报 0 款会让用户以为设置没生效，再回去点一遍。
   */
  shiftedStyles: number;
  /** 撞到码段边界被封顶的行数 */
  clampedRows: number;
  /** 尺码认不出、未换算的行数 */
  unknownRows: number;
  /** 逐款明细（按首次出现的顺序；**空 = 本批没有加码款**） */
  styles: SizeShiftStyleStat[];
}

/**
 * 行级换算：**返回新行**（不改入参），并给改过码的行打上 `orderSize`（下单码原文）。
 *
 * `orderSize` 是这套改造里"追溯"的唯一载体：清单尺码格显示 `L→XL`、拿货单记下单码、
 * 导出表出「下单码」列，都读它。没改码的行**不加这个字段** —— 存量形状不变，
 * 下游（`aggregatePicking`）按"有没有它"判断是否加过码。
 */
export function applySizeShift<T extends SizeShiftRowLike>(
  rows: T[] | null | undefined,
  shiftOf: (styleCode: string) => number,
  chainOf?: (styleCode: string) => string[] | null | undefined
): { rows: (T & { orderSize?: string })[]; stats: SizeShiftStats } {
  const list = Array.isArray(rows) ? rows : [];
  const out: (T & { orderSize?: string })[] = [];
  const byStyle = new Map<string, SizeShiftStyleStat>();
  const stats: SizeShiftStats = {
    shiftedRows: 0,
    shiftedStyles: 0,
    clampedRows: 0,
    unknownRows: 0,
    styles: [],
  };

  for (const row of list) {
    // 已经换算过的行（带 `orderSize`）**不再换算**：同一批数据被算两次会再多加一码，
    // 而且不会报错 —— 派生只要不幂等，重算一次就漂一次（本仓已经踩过三次的坑）。
    if (typeof (row as { orderSize?: unknown })?.orderSize === 'string') {
      out.push(row as T & { orderSize?: string });
      continue;
    }
    const code = String(row?.styleCode ?? '');
    const shift = Math.trunc(Number(shiftOf(code)) || 0);
    if (!shift) {
      out.push(row);
      continue;
    }
    // 逐款计数放在换算**之前**：封顶行 / 认不出行同样算这款的"参与行"，
    // 否则"这款加了码但一行都没生效"在界面上彻底消失（用户会以为设置没保存）。
    const st = byStyle.get(code) ?? {
      styleCode: code,
      shift,
      rows: 0,
      changedRows: 0,
      clampedRows: 0,
      unknownRows: 0,
    };
    st.rows += 1;
    if (code) byStyle.set(code, st);

    const r = shiftSize(row?.size, shift, chainOf ? chainOf(code) : null);
    if (!r.known) {
      // 认不出：**不打标**（它没被换算，`orderSize` 存在会被下游当成"加过码"）
      stats.unknownRows += 1;
      st.unknownRows += 1;
      out.push(row);
      continue;
    }
    if (r.clamped) {
      stats.clampedRows += 1;
      st.clampedRows += 1;
    }
    if (!r.changed) {
      // 封顶（最大码再加码）：码没变，但这行**确实参与了加码**，下单码要留 ——
      // 它会和"下单 5XL→拿 6XL"的行并进同一组，不留标就看不出这 3 件里还有 6XL 下单的。
      out.push(r.clamped ? { ...row, orderSize: String(row?.size ?? '') } : row);
      continue;
    }
    out.push({ ...row, size: r.size, orderSize: String(row?.size ?? '') });
    stats.shiftedRows += 1;
    st.changedRows += 1;
  }
  stats.styles = [...byStyle.values()];
  stats.shiftedStyles = stats.styles.length;
  return { rows: out, stats };
}

/**
 * 尺码链：把一批码排成升序（同码去重）。
 *
 * 排序规则与拣货清单的尺码格一致（字母码按码序、数字码按数值、其余按原串）——
 * 两处各排一套会让"格子的顺序"和"加一码的方向"打架。
 */
export function sizeChain(sizes: Iterable<unknown> | null | undefined): string[] {
  const seen = new Map<string, string>();
  for (const s of sizes ?? []) {
    const raw = String(s ?? '').trim();
    if (!raw) continue;
    const k = normalizeSize(raw);
    if (!seen.has(k)) seen.set(k, raw);
  }
  return [...seen.entries()]
    .sort((a, b) => compareSize(a[1], b[1]))
    .map(([, raw]) => raw);
}

/** 码比较（导出给导出表 / 界面排序复用；与 `sizeChain` 同一口径） */
export function compareSize(a: unknown, b: unknown): number {
  const rank = (raw: unknown): [number, number, string] => {
    const t = normalizeSize(raw);
    const li = letterIndex(t);
    if (li >= 0) return [1, li, ''];
    const n = Number(t);
    if (t !== '' && Number.isFinite(n)) return [2, n, ''];
    return [3, 0, t];
  };
  const ra = rank(a);
  const rb = rank(b);
  return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0);
}
