// src/lib/podStyles.ts
// 「按款认图案」的分组层（纯函数、零依赖 SQL）。
//
// ── 为什么要有这一层（2026-11-03 用户口径）────────────────────────────────────
// 原话：「在归类核对完后，按款图进行用户手动分类汇总图案」「款 A 包含 3 个颜色，每个颜色都有对应的
// SKU 图片，这三张图可能用的是同一个花纸图案 —— 最终我们只需要用任意一张图片存一条花纸图案记录，
// 如果这三张里有两种图案，就需要存两条」。
//
// 也就是说：认图案的**操作单位不是一张订单图，而是"款里的一个颜色"**。
// 一张订单图只能说明"这一单买的是这朵花"，而款色（`oi_style_colors.id`）说明的是
// "这个款这个颜色永远印这朵花" —— 后者才是能被复用的知识，也是「下次同款不用再认」的落点。
//
// 所以这一层只做三件事：
//   ① 把待发货订单行按**款**分组（没归类的按商品ID 兜底，并在界面上标出来）；
//   ② 款内每个颜色合成一张 chip（件数求和、图取第一张有图的、图案按 `podNeed` 的唯一顺序判定）；
//   ③ 统计"这个款用到了几个图案"「还有几件没认」—— 界面的数字与文案都只读这里。
//
// ⚠️ 匹配顺序**不在本文件**：它只有一份实现，在 `podNeed.ts` 的 `podPatternResolver`
//    （款色 → 图片指纹 → 变体键）。这里只调用，绝不另写一套 `if (patternId) …`。

import { isWaitingShip } from './mangoStatus';
import {
  piecesOfQty,
  podPatternResolver,
  type PodMatchVia,
  type PodNeedCandidate,
  type PodNeedPattern,
} from './podNeed';

/** 款里的一个颜色（界面上一张 chip；也是"一次认图案"的最小单位） */
export interface PodStyleColor {
  /** 稳定键（`sc:<款色id>` / `item:<店铺>|<商品ID>|<色>` / `none:<单号>`） */
  key: string;
  /** 款色 id（0 = 这一行还没归类，认图案时只能按图挂） */
  styleColorId: number;
  /** 色名（归类后是自家色名，否则是平台原文） */
  color: string;
  /** 待发件数 */
  pieces: number;
  /** 合成这张 chip 的订单行数 */
  rows: number;
  orderNos: string[];
  shops: string[];
  /** 认图案用的图：订单图指纹优先（同一朵花的实物照），其次款色代表图 */
  imageFingerprint: string;
  imagePath: string;
  imageUrl: string;
  /** 现在的图案（0 = 还没认） */
  patternId: number;
  via: PodMatchVia;
  /** 这个色的几行订单认到了不同图案（要让人看见，别默默取第一条） */
  conflict: boolean;
  /** 有没有可认的凭据（款色 id 或图指纹）；都没有 ⇒ 认不了，界面要说明 */
  bindable: boolean;
}

/** 一个款（界面上一张卡片） */
export interface PodStyleGroup {
  key: string;
  styleId: number;
  /** 款编码；没归类时是 `商品 <itemId>`（界面照原样显示，不伪装成款号） */
  styleCode: string;
  /** true = 还没在「归类核对」认到款色（分组只能按商品ID 兜底） */
  unclassified: boolean;
  colors: PodStyleColor[];
  /** 这个款要发的件数 */
  pieces: number;
  /** 其中还没认图案的件数 */
  unboundPieces: number;
  /** 这个款用到的图案（去重、按首次出现顺序）—— "3 个颜色 2 个图案"读它 */
  patternIds: number[];
  itemIds: string[];
  shops: string[];
  /** 有颜色已经按图认好、但这个色还没记到款上（界面「记到款上」按钮的数字） */
  unsavedColors: number;
}

export interface PodStyleTotals {
  /** 款数（含未归类兜底组） */
  groups: number;
  /** 颜色 chip 数 */
  colors: number;
  /** 待发件数（= 报单页的 `waitingPieces`，同一个口径） */
  pieces: number;
  /** 还没认图案的件数（= 报单页的 `unboundPieces`） */
  unboundPieces: number;
  /** 还有没认图案的颜色的款数 */
  unboundGroups: number;
  /** 已按图/槽位认好、但还没记到款上的颜色数 */
  unsavedColors: number;
  /** 没归类的行数（> 0 时提示先去「归类核对」） */
  unclassifiedColors: number;
}

export interface PodStyleReport {
  groups: PodStyleGroup[];
  totals: PodStyleTotals;
}

export interface PodStyleInput {
  candidates: readonly PodNeedCandidate[];
  bindings?: Readonly<Record<string, number>>;
  imageBindings?: Readonly<Record<string, number>>;
  styleColorBindings?: Readonly<Record<string, number>>;
  patterns: readonly PodNeedPattern[];
  /** 只列"还有没认的颜色"的款（默认 false = 全部要发的款） */
  onlyUnbound?: boolean;
  /** 搜款号 / 色名 / 店铺 / 商品ID */
  search?: string;
}

function normKey(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 分组键：款色所属的款 → 商品ID → 单号（三级兜底，绝不为空） */
function groupKeyOf(c: PodNeedCandidate): { key: string; unclassified: boolean } {
  const styleId = Math.round(Number(c.styleId) || 0);
  if (styleId > 0) return { key: `sc:${styleId}`, unclassified: false };
  const item = normKey(c.itemId);
  if (item) return { key: `item:${item}`, unclassified: true };
  // 连商品ID 都没有：只能按单号单独成组（否则会把不相干的行并成一张卡）
  return { key: `none:${normKey(c.orderNo) || '?'}`, unclassified: true };
}

/** 颜色键：款色 id 优先；否则 (色名 + 图指纹) —— 同名色不同图是两件不同实物 */
function colorKeyOf(c: PodNeedCandidate): string {
  const id = Math.round(Number(c.styleColorId) || 0);
  if (id > 0) return `c${id}`;
  const color = normKey(c.color);
  const fp = normKey(c.imageFingerprint);
  return `x${color}|${fp}`;
}

/** 一行能不能认图案（必须有款色或图；只剩变体键的老数据仍可认，但不作为"按款维护"的依据） */
function bindableOf(c: PodNeedCandidate): boolean {
  const sc = Math.round(Number(c.styleColorId) || 0);
  if (sc > 0) return true;
  if (normKey(c.imageFingerprint)) return true;
  return !!normKey(c.variantKey);
}

function firstNonEmpty(a: string, b: string): string {
  return a || b;
}

/**
 * 按款分组。
 *
 * 只统计**等我发货**的行（`mangoStatus.isWaitingShip`，与报单页同一口径 —— 这里不许写
 * `bizStatus === '待发货'`）。已发货 / 已取消的行不进款卡片，也不进任何数字。
 */
export function podStyleGroupsOf(input: PodStyleInput): PodStyleReport {
  const patterns = Array.isArray(input?.patterns) ? input.patterns : [];
  const resolve = podPatternResolver({
    bindings: input?.bindings,
    imageBindings: input?.imageBindings,
    styleColorBindings: input?.styleColorBindings,
    patterns,
  });
  const savedStyleColors = new Set<number>();
  for (const k of Object.keys(input?.styleColorBindings ?? {})) {
    const n = Math.round(Number(k) || 0);
    if (n > 0) savedStyleColors.add(n);
  }

  const groups = new Map<string, PodStyleGroup>();
  const colorIndex = new Map<string, PodStyleColor>();

  for (const c of Array.isArray(input?.candidates) ? input.candidates : []) {
    if (!c || !isWaitingShip(c?.bizStatus)) continue;
    const { pieces } = piecesOfQty(c?.qty);
    const { key: gkey, unclassified } = groupKeyOf(c);
    const ckey = `${gkey}#${colorKeyOf(c)}`;
    const match = resolve(c);

    let g = groups.get(gkey);
    if (!g) {
      const styleId = Math.round(Number(c.styleId) || 0);
      const item = normKey(c.itemId);
      g = {
        key: gkey,
        styleId,
        styleCode: unclassified
          ? item
            ? `商品 ${item}`
            : normKey(c.orderNo) || '未归类'
          : normKey(c.styleCode) || `款 #${styleId}`,
        unclassified,
        colors: [],
        pieces: 0,
        unboundPieces: 0,
        patternIds: [],
        itemIds: [],
        shops: [],
        unsavedColors: 0,
      };
      groups.set(gkey, g);
    }

    let chip = colorIndex.get(ckey);
    if (!chip) {
      const styleColorId = Math.round(Number(c.styleColorId) || 0);
      chip = {
        key: ckey,
        styleColorId,
        color: normKey(c.styleColorName) || normKey(c.color) || '没写颜色',
        pieces: 0,
        rows: 0,
        orderNos: [],
        shops: [],
        imageFingerprint: '',
        imagePath: '',
        imageUrl: '',
        patternId: match.patternId,
        via: match.via,
        conflict: false,
        bindable: bindableOf(c),
      };
      colorIndex.set(ckey, chip);
      g.colors.push(chip);
    }
    // 同一个颜色的多行：认到不同图案时必须标出来（静默取第一条 = 整批错印）
    if (chip.patternId && match.patternId && chip.patternId !== match.patternId) {
      chip.conflict = true;
    }
    if (!chip.patternId && match.patternId) {
      chip.patternId = match.patternId;
      chip.via = match.via;
    }
    chip.pieces += pieces;
    chip.rows += 1;
    const orderNo = normKey(c.orderNo);
    if (orderNo && !chip.orderNos.includes(orderNo)) chip.orderNos.push(orderNo);
    const shop = normKey(c.shop);
    if (shop && !chip.shops.includes(shop)) chip.shops.push(shop);
    // 图：订单图优先（认图案靠它），空则回落到款色代表图（款卡片显示用）
    chip.imageFingerprint = firstNonEmpty(
      chip.imageFingerprint,
      normKey(c.imageFingerprint) || normKey(c.styleImageFingerprint)
    );
    chip.imagePath = firstNonEmpty(chip.imagePath, normKey(c.imagePath) || normKey(c.styleImagePath));
    chip.imageUrl = firstNonEmpty(chip.imageUrl, normKey(c.imageUrl));

    g.pieces += pieces;
    if (!match.patternId) g.unboundPieces += pieces;
    const item = normKey(c.itemId);
    if (item && !g.itemIds.includes(item)) g.itemIds.push(item);
    if (shop && !g.shops.includes(shop)) g.shops.push(shop);
  }

  const list: PodStyleGroup[] = [];
  for (const g of groups.values()) {
    for (const chip of g.colors) {
      if (chip.patternId && !g.patternIds.includes(chip.patternId)) g.patternIds.push(chip.patternId);
      // "已按图认好、但款色还没记下来" —— 只有这种才需要点「记到款上」
      if (
        chip.styleColorId > 0 &&
        chip.patternId > 0 &&
        chip.via !== 'styleColor' &&
        !savedStyleColors.has(chip.styleColorId)
      ) {
        g.unsavedColors += 1;
      }
    }
    g.colors.sort((a, b) => b.pieces - a.pieces || (a.color < b.color ? -1 : a.color > b.color ? 1 : 0));
    list.push(g);
  }

  const q = normKey(input?.search).toLowerCase();
  const visible = list.filter((g) => {
    if (input?.onlyUnbound && g.unboundPieces <= 0) return false;
    if (!q) return true;
    const hay = [
      g.styleCode,
      ...g.colors.map((c) => c.color),
      ...g.shops,
      ...g.itemIds,
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
  // 还有没认的排前面（那是今天要做的活），同档按件数、再按款号 —— 稳定顺序，刷新不跳行
  visible.sort(
    (a, b) =>
      (b.unboundPieces > 0 ? 1 : 0) - (a.unboundPieces > 0 ? 1 : 0) ||
      b.unboundPieces - a.unboundPieces ||
      b.pieces - a.pieces ||
      (a.styleCode < b.styleCode ? -1 : a.styleCode > b.styleCode ? 1 : 0)
  );

  const totals: PodStyleTotals = {
    groups: visible.length,
    colors: 0,
    pieces: 0,
    unboundPieces: 0,
    unboundGroups: 0,
    unsavedColors: 0,
    unclassifiedColors: 0,
  };
  for (const g of visible) {
    totals.colors += g.colors.length;
    totals.pieces += g.pieces;
    totals.unboundPieces += g.unboundPieces;
    totals.unsavedColors += g.unsavedColors;
    if (g.unboundPieces > 0) totals.unboundGroups += 1;
    for (const c of g.colors) if (c.styleColorId <= 0) totals.unclassifiedColors += 1;
  }

  return { groups: visible, totals };
}

/**
 * 这个款里已经用过的图案（认新颜色时排在前面当建议）。
 *
 * 用户的操作是"这个色和前面那个色是同一朵花" —— 把本款已用的图案排在最前，
 * 一次点击就完成；不给建议的话他得在几十个图案里找同一个编号。
 */
export function podStyleSuggestionIds(group: PodStyleGroup | null | undefined): number[] {
  if (!group) return [];
  return [...group.patternIds];
}

/** 选中了 N 个颜色后，用哪个图案 —— 一句话给按钮用（不给图案时不显示猜测） */
export function podStylePickHint(selectedColors: number, samePattern: boolean): string {
  const n = Math.max(0, Math.round(Number(selectedColors) || 0));
  if (n <= 0) return '先点颜色图选中（可多选：同一个花的颜色一起选）';
  if (samePattern) return `${n} 个颜色共用这一个图案（只存一条花纸）`;
  return `${n} 个颜色会分到选中图案`;
}
