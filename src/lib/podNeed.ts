// src/lib/podNeed.ts
// **图案净需件**（M4·T4-1/T4-2 的判定层，纯函数、零依赖于 SQL）。
//
// 为什么不在 SQL 里做一个 `pod_order_need` 视图（计划附录 A 原方案）：
// 那个视图要求「待发货集合与 T2-1 同一份实现」，而状态口径的唯一实现是本仓库
// `src/lib/mangoStatus.ts` 的**正则规则**（芒果不同页面给"等待卖家发货 / 待发货 / 待卖家发货"）。
// SQL 里只能手写 `biz_status IN ('待发货', …)` —— 那就是第二套口径，而"发货台说 3 单待发、
// 报单说 5 件要印"正是这么来的（计划自己也在附录 A 底下警告过一句）。
// 所以拆成两段、只留一份口径：
//   ① 主进程 `electron/pod-need.ts` 只做**投影**（订单行 + 绑定索引 + 余量，原样搬给渲染层）；
//   ② 本文件做**聚合**（按图案求和 + 扣余量 + 算张数），`isWaitingShip` 只在这里被调用一次。
//
// 三条口径（都踩过坑，别在界面里另写一份）：
//   ① **件数按行算，不按"单"算**：一单三行三个图案，报单时三个图案各自要料。
//      `qty` 为空的导入行按 1 件计并计数（`assumedRows`）—— 静默当 0 会让净需件偏小，
//      而偏小的报单意味着"料不够，等发现了再补"。
//   ② **余量按件扣，扣到 0 为止，允许为负时归零**：余量是账面事实，净需件是"还差多少"；
//      把负余量当"欠料"加进净需件，会让一行明明够料的图案也进报单。
//   ③ **未绑定的待发件必须单独计数并显示**（`unboundPieces`）。真库实测：560 个槽位
//      只覆盖 2/16 家店，75 个订单行里只有 4 行能匹配到槽位 —— 若报单只汇总"已绑定"的，
//      会出现"3 个图案要报单"这种看似正常、实则漏掉九成订单的画面。漏报比多报贵得多。

import { isWaitingShip } from './mangoStatus';

/** 一行输入（来自 `electron/pod-need.ts` 的投影；字段名与 IPC 载荷逐字对应） */
export interface PodNeedCandidate {
  /** 变体键（空 = 这个订单行没有商品ID，永远匹配不到图案） */
  variantKey: string;
  /**
   * 订单图的内容指纹（`md_images.fingerprint`；空 = 这一行没图）。
   * 2026-11-02 起**优先按它认图案**（用户口径「根据订单中的图片来决定印什么花」），
   * 空或没认过才回退 `variantKey`。
   */
  imageFingerprint?: string;
  /** 芒果状态原文（`oi_orders.biz_status`） */
  bizStatus: string;
  /** 件数真值；null = 不知道（按 1 计并计数） */
  qty: number | null;
  shop?: string;
  orderNo?: string;
  /** 商品ID（界面上"这张图是哪件商品"；不参与匹配） */
  itemId?: string;
  /** 订单行的颜色原文（界面上"这张图覆盖了哪些颜色"；**不参与匹配**，禁降级到色名） */
  color?: string;
  /** 订单图的本地路径（界面缩略图用；不参与匹配） */
  imagePath?: string;
  /** 订单图的原始 URL（本地文件丢了时界面可重新下载；不参与匹配） */
  imageUrl?: string;
  /**
   * 款色 id（`oi_style_colors.id`；0/空 = 这一行还没在「归类核对」里认到款色）。
   * 2026-11-03 起**最优先**按它认图案：用户口径「款色认一次，下次同款不用再对应」。
   */
  styleColorId?: number;
  /** 款色名（自家色名；界面标题用，不参与匹配） */
  styleColorName?: string;
  /** 款 id / 款编码（界面按款分组用，不参与匹配） */
  styleId?: number;
  styleCode?: string;
  /** 款色代表图的指纹（界面显示"款图"；不参与匹配 —— 它是展示图，不是订单图） */
  styleImageFingerprint?: string;
  /** 款色代表图的本地路径 */
  styleImagePath?: string;
}

/** 图案（`pod_patterns` + 余量视图的一行） */
export interface PodNeedPattern {
  id: number;
  code: string;
  name: string;
  artworkImageId: number;
  previewImageId: number;
  /** 当前余量（件），来自 `pod_pattern_balance` */
  remainingPieces: number;
}

export interface PodNeedInput {
  candidates: readonly PodNeedCandidate[];
  /** 绑定索引：`variant_key → pattern_id`（主进程 `podBindingIndex()` 的产物） */
  bindings: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  /**
   * 图片绑定索引：`图片指纹 → pattern_id`（主进程 `podImageIndex()` 的产物）。
   * **优先于** `bindings`：用户口径是「根据订单中的图片来决定印什么花」，
   * 槽位键只是没有图时的兜底（老订单 / 平台没给图）。
   */
  imageBindings?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  /**
   * 款色 id → pattern_id（主进程 `podStyleColorIndex()` 的产物）。
   * **最优先**：它是"按款维护的图案数据"，同款同色换了商品图也还认得（用户口径：
   * 「下次遇到同款时就不用再对应了」）。
   */
  styleColorBindings?: ReadonlyMap<string | number, number> | Readonly<Record<string, number>>;
  patterns: readonly PodNeedPattern[];
  /** 每张花纸多少件（排版值；报单张数 = ceil(净需件 / 每张件数)） */
  piecesPerSheet?: number;
}

/** 报单表的一行（= 一个图案） */
export interface PodNeedRow {
  patternId: number;
  code: string;
  name: string;
  /** 图稿（制版用；**不是**预览图 —— 传错花模图整批报废，红线 7） */
  artworkImageId: number;
  previewImageId: number;
  /** 待印件（待发货里绑到这个图案的件数） */
  needPieces: number;
  /** 现有余量（件） */
  remainingPieces: number;
  /** 净需件 = max(0, 待印 - 余量) */
  netNeed: number;
  /** 报单张数 = ceil(净需件 / 每张件数)；净需件为 0 时为 0 */
  sheets: number;
}

export interface PodNeedReport {
  /** 需要报单的行（净需件 > 0），按净需件倒序 */
  rows: PodNeedRow[];
  /** 待发货**总件数**（含未绑定） */
  waitingPieces: number;
  /** 能匹配到图案的待发货件数 */
  boundPieces: number;
  /** 匹配不到图案（含键为空）的待发货件数 —— **> 0 时报单必然偏少，界面必须说** */
  unboundPieces: number;
  /** 匹配不到图案的订单行数 */
  unboundRows: number;
  /** 件数按 1 兜底的行数（> 0 时件数偏小） */
  assumedRows: number;
  /** 净需件合计（= 要报单的件数） */
  shortPieces: number;
  /** 报单张数合计 */
  totalSheets: number;
  /** 每张件数（回显给界面，避免界面自己记一份默认值） */
  piecesPerSheet: number;
}

/** 每张件数上限（与 `pod-db.MAX_PIECES_PER_SHEET` 同量级；超过它不是排版，是单位填错了） */
export const MAX_PIECES_PER_SHEET = 1000;
/** 订花纸页默认每张件数（用户可改；只影响"张数"这一列，不影响净需件） */
export const DEFAULT_PIECES_PER_SHEET = 1;

/** 件数：null / 0 / 负数 → 1（并按 assumed 计数）；小数四舍五入 */
export function piecesOfQty(qty: unknown): { pieces: number; assumed: boolean } {
  const n = typeof qty === 'number' ? qty : Number(qty);
  if (!Number.isFinite(n) || n <= 0) return { pieces: 1, assumed: true };
  return { pieces: Math.round(n), assumed: false };
}

/** 张数 = ceil(净需件 / 每张件数)；净需件 ≤ 0 → 0（"够料"不进报单） */
export function sheetsOf(netNeed: number, piecesPerSheet: number): number {
  const need = Math.max(0, Math.round(Number(netNeed) || 0));
  const per = Math.round(Number(piecesPerSheet) || 0);
  if (need <= 0) return 0;
  if (per <= 0) return need; // 每张件数没填好 ⇒ 按"一张一件"报，不报 0 张（报 0 张 = 这单没人做）
  return Math.ceil(need / per);
}

function bindingIdOf(bindings: PodNeedInput['bindings'] | undefined, key: string): number {
  if (!key || !bindings) return 0;
  const v = bindings instanceof Map ? bindings.get(key) : (bindings as Record<string, number>)[key];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** 认图案的三种口径（界面要能说"这个色是按款认的 / 按图认的 / 按颜色槽位认的"） */
export type PodMatchVia = 'styleColor' | 'image' | 'slot' | 'none';

export interface PodMatchResult {
  patternId: number;
  via: PodMatchVia;
}

/**
 * 判定闭包的输入：图案集合必须有（否则什么都认不出来），三个绑定索引可以缺 ——
 * 界面按需只给其中一两个（例如"只看按款认的"）不该因为少传一个索引就报错。
 */
export type PodResolverInput = Pick<PodNeedInput, 'patterns'> &
  Partial<Pick<PodNeedInput, 'bindings' | 'imageBindings' | 'styleColorBindings'>>;

/**
 * 一行订单能认到哪个图案 —— **匹配顺序的唯一实现**（界面与报单都必须调这里，不许各写一份）。
 *
 * 顺序：
 *   ① **款色**（`style_color_id` → `pod_style_color_patterns`）。2026-11-03 新增，排最前：
 *      用户口径是「按款维护图案数据，下次遇到同款不用再对应」。款色换了商品图（换季重拍/
 *      同款在不同店铺各一套图）也还认得，这是"自动维护"的唯一落点。
 *   ② **图片指纹**（`md_images.fingerprint` → `pod_pattern_images`）。用户口径：
 *      「最终我们肯定是根据订单中的图片来决定印什么花的」。
 *   ③ 变体键（颜色槽位）兜底 —— 老订单 / 平台没给图 / 这张图还没人认过。
 *   ④ 都没有 = `none`（报单里算未绑定，界面要提示"这个颜色还没认图案"）。
 *
 * 三种口径都要校验"图案还在"（`active` 且没被合并）：绑到已删 / 已并走的图案按未认处理，
 * 否则净需件会指向一个界面上根本看不到的图案。
 *
 * ⚠️ 一屏几千行时不要逐行调这个（它每次都会重建图案集合），用 `podPatternResolver` 取一次闭包。
 */
export function podResolvePattern(
  candidate: PodNeedCandidate | undefined,
  input: PodResolverInput
): PodMatchResult {
  return podPatternResolver(input)(candidate);
}

/** 取一个"行 → 图案"的判定闭包（图案集合只建一次；报表与界面列表都用它） */
export function podPatternResolver(
  input: PodResolverInput
): (candidate: PodNeedCandidate | undefined) => PodMatchResult {
  const byId = new Set<number>();
  for (const p of Array.isArray(input?.patterns) ? input.patterns : []) {
    const id = Math.round(Number(p?.id) || 0);
    if (id > 0) byId.add(id);
  }
  const bindings = input?.bindings;
  const imageBindings = input?.imageBindings;
  const styleColorBindings = input?.styleColorBindings;
  /** 款色索引的键是数字（IPC 后是字符串）—— 两种都要认 */
  const styleColorIdOf = (candidate: PodNeedCandidate): number => {
    const raw = Math.round(Number(candidate?.styleColorId) || 0);
    return raw > 0 ? raw : 0;
  };
  return (candidate) => {
    if (!candidate) return { patternId: 0, via: 'none' };
    // ① 款色（稳定身份，优先于一切图像证据）
    const scId = styleColorIdOf(candidate);
    if (scId > 0 && styleColorBindings) {
      const pid = bindingIdOf(styleColorBindings as Readonly<Record<string, number>>, String(scId));      if (pid && byId.has(pid)) return { patternId: pid, via: 'styleColor' };
    }
    // ② 订单图片指纹
    const tip =
      typeof candidate.imageFingerprint === 'string' ? candidate.imageFingerprint.trim() : '';
    if (tip) {
      const pid = bindingIdOf(imageBindings, tip);
      if (pid && byId.has(pid)) return { patternId: pid, via: 'image' };
    }
    // ③ 变体键兜底
    const key = typeof candidate.variantKey === 'string' ? candidate.variantKey : '';
    const pid = bindingIdOf(bindings, key);
    if (pid && byId.has(pid)) return { patternId: pid, via: 'slot' };
    return { patternId: 0, via: 'none' };
  };
}

/**
 * 净需件报表（按图案聚合、跨店铺 —— 同款不同店是同一个图案，料是共用的）。
 *
 * @param input 订单行投影 + 绑定索引 + 图案余量 + 每张件数
 */
export function podNeedReport(input: PodNeedInput): PodNeedReport {
  const per =
    Number.isFinite(Number(input?.piecesPerSheet)) &&
    Number(input.piecesPerSheet) > 0 &&
    Number(input.piecesPerSheet) <= MAX_PIECES_PER_SHEET
      ? Math.round(Number(input.piecesPerSheet))
      : DEFAULT_PIECES_PER_SHEET;

  const patterns = Array.isArray(input?.patterns) ? input.patterns : [];
  const byId = new Map<number, PodNeedPattern>();
  for (const p of patterns) {
    const id = Math.round(Number(p?.id) || 0);
    if (id > 0) byId.set(id, p);
  }

  const needByPattern = new Map<number, number>();
  let waitingPieces = 0;
  let boundPieces = 0;
  let unboundPieces = 0;
  let unboundRows = 0;
  let assumedRows = 0;
  // 图案集合只建一次：几千行逐个重建 Set 是没必要的开销（见 `podPatternResolver` 的注释）
  const resolve = podPatternResolver({
    bindings: input?.bindings,
    imageBindings: input?.imageBindings,
    styleColorBindings: input?.styleColorBindings,
    patterns,
  });

  for (const c of Array.isArray(input?.candidates) ? input.candidates : []) {
    // 只算"等我发货"的行：状态口径唯一实现在 mangoStatus（这里不许写 `=== '待发货'`）
    if (!isWaitingShip(c?.bizStatus)) continue;
    const { pieces, assumed } = piecesOfQty(c?.qty);
    if (assumed) assumedRows += 1;
    waitingPieces += pieces;
    // 认图案顺序（图片指纹优先、变体键兜底）只有一份实现，见 `podResolvePattern` 的注释
    const { patternId: pid } = resolve(c);
    // 没认出来（含键为空 / 绑到的图案已删或已合并）时按"未绑定"计：
    // 否则净需件会指向一个查不出来的图案，或把整批漏掉（漏报比多报贵得多）
    if (!pid) {
      unboundPieces += pieces;
      unboundRows += 1;
      continue;
    }
    boundPieces += pieces;
    needByPattern.set(pid, (needByPattern.get(pid) ?? 0) + pieces);
  }

  const rows: PodNeedRow[] = [];
  for (const [pid, needPieces] of needByPattern) {
    const p = byId.get(pid) as PodNeedPattern;
    const remaining = Math.max(0, Math.round(Number(p.remainingPieces) || 0));
    const netNeed = Math.max(0, needPieces - remaining);
    rows.push({
      patternId: pid,
      code: p.code ?? '',
      name: p.name ?? '',
      artworkImageId: Math.round(Number(p.artworkImageId) || 0),
      previewImageId: Math.round(Number(p.previewImageId) || 0),
      needPieces,
      remainingPieces: remaining,
      netNeed,
      sheets: sheetsOf(netNeed, per),
    });
  }
  // 净需件倒序（要报最多的先做决定）；同量按编码 —— 稳定顺序，刷新不会跳行
  rows.sort((a, b) => b.netNeed - a.netNeed || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const ordered = rows.filter((r) => r.netNeed > 0);

  return {
    rows: ordered,
    waitingPieces,
    boundPieces,
    unboundPieces,
    unboundRows,
    assumedRows,
    shortPieces: ordered.reduce((s, r) => s + r.netNeed, 0),
    totalSheets: ordered.reduce((s, r) => s + r.sheets, 0),
    piecesPerSheet: per,
  };
}

/**
 * 这份清单能不能信 —— 一句话结论，界面与导出的清单都要带上。
 *
 * 判据只有一条：**有还没认图案的待发件时，清单必然偏少**。
 * 不把"都认过了"当成可信：还要有图案、有订单；那些是空态处理（见 `podNeedEmptyOf`）。
 */
export function podNeedTrustOf(report: PodNeedReport): {
  ok: boolean;
  text: string;
  tone: 'ok' | 'warn' | 'danger';
} {
  const unbound = Math.max(0, Math.round(Number(report?.unboundPieces) || 0));
  if (unbound > 0) {
    return {
      ok: false,
      text: `还有 ${unbound} 件要发的没认图案（${report.unboundRows} 行）—— 这份清单会偏少`,
      tone: 'danger',
    };
  }
  const assumed = Math.max(0, Math.round(Number(report?.assumedRows) || 0));
  if (assumed > 0) {
    return {
      ok: false,
      text: `${assumed} 行没写件数，已按 1 件算 —— 实际可能更多`,
      tone: 'warn',
    };
  }
  return { ok: true, text: '所有要发的件数都认好图案了，这份清单是完整的', tone: 'ok' };
}

/** 空态分三种（与「发货台」空态同一纪律：0 不等于"没事"，要说清是哪种 0） */
export type PodNeedEmptyKind = 'noOrders' | 'noPatterns' | 'enoughStock';

export function podNeedEmptyOf(
  report: PodNeedReport,
  patternCount: number
): PodNeedEmptyKind | null {
  if (Math.max(0, Number(report?.waitingPieces) || 0) <= 0) return 'noOrders';
  if (Math.max(0, Number(patternCount) || 0) <= 0) return 'noPatterns';
  if (!Array.isArray(report?.rows) || report.rows.length === 0) return 'enoughStock';
  return null;
}
