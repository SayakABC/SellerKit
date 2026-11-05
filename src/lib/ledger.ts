// src/lib/ledger.ts
// 记账分摊引擎（纯函数，零依赖，无副作用）。
//
// 这是整个记账功能**唯一**有正确性风险的计算：一笔公共支出摊到 N 家店，必须
//   ① 合计恒等于条目金额（差 1 分钱，汇总页就会对不上，且没人能查出来是哪里少的）；
//   ② 同样的输入永远得到同样的输出（否则"重算幂等"这条判据失效，分摊行会无端飘动）。
//
// 为什么算法只放在这里（见 docs/plans/LEDGER_PLAN.md §5.5）：
//   主进程 `ledger-db.ts` 只做**守恒断言**、不做计算。一旦主进程也算一遍，就会出现
//   两份实现，而本项目已经因为「同一件事两套口径」出过三次问题（aeMoney 被迫补 parity 用例
//   就是前车之鉴）。这里唯一的例外是将来出现非渲染层写入方（Excel 批量导入 / 定时生成），
//   那时才把算法下沉并补 parity。
//
// ⚠️ `ratioBp` 是**权重快照**，不是金额占比，也**不是任何判据**。
//   它的用途只有两个：界面展示"这家摊 33%"、重算时能看出当时的基准快照。
//   金额一律以 `amountCents` 为准。四舍五入后的 bp 合计可能是 9999 或 10001，
//   这是占比的固有舍入，不是 bug —— 拿 bp 去反算金额才会真的产生误差。

/** 分摊基准：平均 / 按营收占比 / 手工比例 */
export type LedgerBasis = 'equal' | 'revenue' | 'manual';

/** 三种基准的合法值（主进程入参消毒与界面下拉共用一份） */
export const LEDGER_BASES: readonly LedgerBasis[] = ['equal', 'revenue', 'manual'];

/**
 * 单笔金额上限：10 亿元（`1e11` 分）。
 *
 * 这是**业务护栏**（一笔账不该大到这个量级），不再是精度护栏 —— 尾差分配已改用 BigInt
 * （`amount × weight` 在营收基准下是两个"分"相乘，`Number` 很容易越过安全整数区）。
 */
export const MAX_ALLOC_AMOUNT_CENTS = 1e11;

/** 分摊参与方（一行 = 一家店） */
export interface AllocParticipant {
  /** 店铺主键（`sk_shops.id`）；必须 > 0 且不重复 */
  shopId: number;
  /**
   * 权重，含义随基准变化；`equal` 时**忽略**（恒按 1 分）。
   * - `revenue`：该店当期营收，单位**分**，允许 0（0 = 当期没营收，摊 0）
   * - `manual`：万分比（bp），Σ 必须恰好 10000
   */
  weight?: number;
}

/** 一行分摊结果（落 `bk_allocations` 的形状） */
export interface AllocationRow {
  shopId: number;
  /** 该店承担金额（整数分，≥ 0） */
  amountCents: number;
  /** 权重快照（万分比，仅供展示；勿用于反算金额） */
  ratioBp: number;
}

/** 分摊结果 */
export interface AllocResult {
  /** **按 shopId 升序**返回 —— 输出顺序确定，重算比较才能逐项对（不靠 SQL 返回顺序） */
  rows: AllocationRow[];
  /** 实际生效的基准（`revenue` 全零回落后是 `equal`） */
  basis: LedgerBasis;
  /** 是否发生了回落：营收占比但所有参与店营收都是 0，改按平均摊 */
  fallback: boolean;
}

/** 金额合法性：必须是正的整数分 */
export function assertAmountCents(amountCents: unknown): number {
  if (typeof amountCents !== 'number' || !Number.isFinite(amountCents)) {
    throw new Error('金额必须是数字');
  }
  if (!Number.isInteger(amountCents)) throw new Error('金额必须是整数分（不接受小数）');
  if (amountCents <= 0) throw new Error('金额必须大于 0');
  if (amountCents > MAX_ALLOC_AMOUNT_CENTS) throw new Error('单笔金额超出上限（10 亿元）');
  return amountCents;
}

/**
 * 按权重把金额拆成整数分，走**最大余数法**（唯一口径，见方案 §5.2）：
 *   1. 先向下取整得基数；
 *   2. 剩余的分（恒 < 参与店数）按小数部分降序逐分追加；
 *   3. 小数部分相同 → 按 shopId 升序优先。
 *
 * 算术全程 BigInt：营收基准下 `amountCents × weight` 是**两个"分"相乘**
 * （10 亿元 × 全年营收轻易越过 `Number.MAX_SAFE_INTEGER`），用 Number 会在
 * 没人察觉的情况下丢掉几分钱 —— 而这是"合计对不上"里最难查的一类。
 *
 * 恒定成立 `Σ amountCents == amount`；这条由调用方（以及主进程）再断言一次。
 */
function distribute(
  amountCents: number,
  rows: Array<{ shopId: number; weight: number }>,
): AllocationRow[] {
  if (!rows.length) throw new Error('没有参与分摊的店铺');

  // 重复 shopId 必须在结构上拒绝：同一家店两行分摊，汇总会把它算两遍，
  // 而界面上看起来"就是两家店"，事后无从查起。
  const seen = new Set<number>();
  for (const r of rows) {
    if (!Number.isInteger(r.shopId) || r.shopId <= 0) {
      throw new Error(`参与店铺 id 非法：${String(r.shopId)}`);
    }
    if (seen.has(r.shopId)) throw new Error(`参与店铺重复：${r.shopId}`);
    seen.add(r.shopId);
    // 权重必须是安全整数：非整数或超出安全区（如小数营收、NaN）不能"约等于"着用
    if (!Number.isSafeInteger(r.weight) || r.weight < 0) {
      throw new Error(`分摊权重非法（必须是非负整数）：店铺 ${r.shopId}`);
    }
  }

  const total = rows.reduce((s, r) => s + BigInt(r.weight), 0n);
  if (total <= 0n) throw new Error('分摊权重合计必须大于 0');

  const amount = BigInt(amountCents);
  const parts = rows.map((r) => {
    const numerator = amount * BigInt(r.weight);
    return {
      shopId: r.shopId,
      weight: r.weight,
      base: numerator / total,
      rem: numerator % total,
    };
  });

  // 只剩「小数部分」要补：left 恒 < weight>0 的行数（见方案 §5.2 的证明），
  // 所以不会出现"补给权重为 0 的店"这种凭空冒出来的分摊。
  let left = amount - parts.reduce((s, p) => s + p.base, 0n);
  const order = parts
    .filter((p) => p.weight > 0)
    .sort((a, b) => (a.rem === b.rem ? a.shopId - b.shopId : a.rem > b.rem ? -1 : 1));

  const bonus = new Set<number>();
  for (const p of order) {
    if (left <= 0n) break;
    bonus.add(p.shopId);
    left -= 1n;
  }
  if (left > 0n) {
    // 数学上不可能走到这里；留着是因为"不可能"一旦发生就是金额算错，
    // 宁可整笔拒绝，也不要静默少摊几分钱。
    throw new Error(`尾差分配异常：仍有 ${left} 分未分配`);
  }

  /** 占比快照（万分比，四舍五入；仅展示用，**不参与金额判定**） */
  const ratioBpOf = (weight: number): number =>
    Number((BigInt(weight) * 20000n + total) / (2n * total));

  return parts
    .map((p) => ({
      shopId: p.shopId,
      amountCents: Number(p.base + (bonus.has(p.shopId) ? 1n : 0n)),
      ratioBp: ratioBpOf(p.weight),
    }))
    .sort((a, b) => a.shopId - b.shopId);
}

/**
 * 算分摊（对外唯一入口）。
 *
 * @param amountCents 条目金额（整数分、> 0）
 * @param basis 基准
 * @param participants 参与店铺（`revenue` 传营收分、`manual` 传 bp）
 */
export function computeAllocations(
  amountCents: number,
  basis: LedgerBasis,
  participants: readonly AllocParticipant[],
): AllocResult {
  const amount = assertAmountCents(amountCents);
  if (!LEDGER_BASES.includes(basis)) throw new Error(`未知分摊基准：${String(basis)}`);
  if (!Array.isArray(participants) || !participants.length) {
    throw new Error('公共支出至少要选一家参与店铺');
  }

  if (basis === 'equal') {
    return {
      rows: distribute(
        amount,
        participants.map((p) => ({ shopId: p.shopId, weight: 1 })),
      ),
      basis,
      fallback: false,
    };
  }

  if (basis === 'revenue') {
    const weights = participants.map((p) => ({ shopId: p.shopId, weight: p.weight ?? 0 }));
    const totalRevenue = weights.reduce((s, w) => s + (Number.isFinite(w.weight) ? w.weight : 0), 0);
    // 当期全部店铺零营收：按营收摊会让所有店都摊 0（这笔钱就从店铺维度消失了），
    // 故回落平均，并把 fallback=true 交给上层在条目上标注"各店无营收，已按平均分摊"。
    if (!(totalRevenue > 0)) {
      return {
        rows: distribute(
          amount,
          participants.map((p) => ({ shopId: p.shopId, weight: 1 })),
        ),
        basis: 'equal',
        fallback: true,
      };
    }
    return { rows: distribute(amount, weights), basis, fallback: false };
  }

  // manual：Σ bp 必须恰好 10000。不做自动补齐 —— 差的那点可能是"用户少填了一家"，
  // 补齐等于替用户猜意图，而猜错的表现是"某家店默默多摊了钱"。
  const weights = participants.map((p) => ({ shopId: p.shopId, weight: p.weight ?? 0 }));
  const totalBp = weights.reduce((s, w) => s + w.weight, 0);
  if (totalBp !== 10000) {
    const gapPct = (Math.abs(totalBp - 10000) / 100).toFixed(2);
    const head = `手工比例合计 ${(totalBp / 100).toFixed(2)}%`;
    throw new Error(totalBp < 10000 ? `${head}，还差 ${gapPct} 个百分点` : `${head}，超出 ${gapPct} 个百分点`);
  }
  return { rows: distribute(amount, weights), basis, fallback: false };
}

/** 守恒差额：`Σ 分摊 − 条目金额`，正常恒为 0；非 0 即拒绝落库 */
export function conservationGap(amountCents: number, rows: readonly AllocationRow[]): number {
  return rows.reduce((s, r) => s + (Number.isFinite(r.amountCents) ? r.amountCents : 0), 0) - amountCents;
}

/**
 * 逐行比较两组分摊是否等价（重算幂等的判据）。
 *
 * 判据取**事实值**（shopId + 金额），不取 `ratioBp`：占比是展示用的舍入值，
 * 拿它做比较会因为 1bp 的舍入抖动触发无意义的"删了重插"，`updated_at` 就虚动了。
 * 入参顺序无关（内部按 shopId 归一），因此不必先排序。
 */
export function allocationsEqual(
  a: readonly AllocationRow[],
  b: readonly AllocationRow[],
): boolean {
  if (a.length !== b.length) return false;
  const map = new Map<number, number>();
  for (const r of a) map.set(r.shopId, (map.get(r.shopId) ?? 0) + r.amountCents);
  for (const r of b) {
    const hit = map.get(r.shopId);
    if (hit === undefined || hit !== r.amountCents) return false;
    map.delete(r.shopId);
  }
  return map.size === 0;
}

/**
 * 发生日 → 期间（`YYYY-MM`）。
 *
 * 期间必须**由数据层从日期派生并落库**，不许前端另算：一旦两边算法不同（比如一边按
 * 录入日、一边按发生日），跨月那几笔就会漏进某个月的汇总，而且没有任何报错。
 */
export function periodOf(bizDate: string): string {
  if (!isValidBizDate(bizDate)) throw new Error('日期格式必须是 YYYY-MM-DD 且为真实日期');
  return bizDate.slice(0, 7);
}

/** 严格校验 `YYYY-MM-DD`（拒绝 2026-02-30 这种"格式对、日子不存在"的值） */
export function isValidBizDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 元 → 分（输入框解析，界面唯一入口）。
 *
 * 接受 `1234.56` / `1,234.56` / `¥1234` / 前后空白；只接受**最多两位小数**。
 * 拒绝超过两位小数而不是替用户四舍五入：`1.005` 静默变成 `1.01` 是"账上多了 5 厘"，
 * 而记账的每一分钱都要能对上条目 —— 宁可让用户自己决定写成 1.00 还是 1.01。
 *
 * @returns 正整数分；`null` = 不合法（文案由调用方给，解析层不拼提示）
 */
export function parseYuanToCents(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^[¥￥]\s*/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [intPart, decPart = ''] = s.split('.');
  // 位数先挡：10 位整数部分 = 最多 1e9 元（正好等于上限），再长就必须换 BigInt；
  // 不先挡的话 `Number('9'.repeat(20)) * 100` 仍"是数字"，但已越过安全整数区。
  if (intPart.length > 10) return null;
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_ALLOC_AMOUNT_CENTS) return null;
  return cents;
}

/** 万元/元展示（仅用于界面与日志；记账内部一律整数分） */
export function formatCents(cents: number): string {
  const v = Number.isFinite(cents) ? Math.round(cents) : 0;
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * 「记一笔」的默认发生日：当月就填今天，别的月份填该月 1 日。
 *
 * `month` 必须是 `YYYY-MM`；**任何别的值一律回落今天所在月**，这是本函数存在的唯一原因：
 * 视图里 `month` 可能是「全部日期」哨兵（`'all'`），直接拼 `${month}-01` 会得到 `'all-01'`，
 * `input[type=date]` 会把非法值渲染成空 → 日期为空 → 公共区报"没有可分摊店铺" → 保存撞
 * "发生日期不合法"，而用户只是点了「全部」按钮（审查 P0-1）。
 */
export function defaultBizDate(month: string, today: string): string {
  const m = /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
  return m === today.slice(0, 7) ? today : `${m}-01`;
}
