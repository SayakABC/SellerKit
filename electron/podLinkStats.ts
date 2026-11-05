// electron/podLinkStats.ts
// **链接判别力统计**的纯函数层（零依赖：只 import `./podImageKey` 的 `imageKeyOf`；
// 不碰 better-sqlite3 / 文件 / 网络）。
//
// 它回答一个问题：**这条链接（一个商品ID）里的变体键，能不能唯一定位到一个图案？**
//   · 每个色名只有一张图 ⇒ 色名本身就是判别证据，3 段键够用，直接绑；
//   · 某个色名挂着 5 张不同的图 ⇒ 这 5 个图案在这条链接里**塌陷成同一个键**
//     （平台色名全写成 `Picture color`，真库 7/71 链接如此），必须靠第 4 段图键才分得开。
//
// 为什么要单独存成列而不是每次现算：判别力是"这条链接的属性"，绑定台、批量筛选、
// 重算脚本（M3·T3-6）都要按它筛（`WHERE pod_n_images > 1`）。每次现算 = 每次都要
// 解析全库 sku_json，且**没有一个人能一眼看出"哪几条链接塌陷"** —— 那份清单迟早会过期。
//
// 为什么摘成纯模块（与 `shopName` / `shopSku` / `variantKey` / `podImageKey` 同一理由）：
// `electron/*-db.ts` 因 better-sqlite3 的 Electron ABI 在系统 Node 下 load 不进来，
// 只能走 `scripts/*-smoke.cjs`。而"几个色/几个图"的边界情形（缺 imageUrl / 同图重复行 /
// 空色名 / 脏 JSON）恰恰是最容易算错的地方，摘出来才能被 vitest 直接覆盖。

import { imageKeyOf } from './podImageKey';

export interface PodLinkStats {
  /**
   * **不同色名的个数**（`color` 归一后去重）。空串**算一个色名** —— 那是"报表没给色"这个
   * 真实存在的桶，与 `variantKeyOf` 的色段、`pod_binding_worklist` 的 `GROUP BY color` 同口径。
   * 不算它会让"1 个真色 + 若干无色行"看起来像"只有 1 个色"，从而被误判成塌陷链接。
   */
  nColors: number;
  /**
   * **同一色名下不同图键个数的最大值**（0 = 一个图键都没认出来）。
   *
   * 为什么取"每个色名的最大值"而不是"整条链接的图总数"：后者会把
   * 「5 个色各挂 1 张图」算成 5 —— 那种链接**完全不需要**图键（色名已经分开了）；
   * 而「1 个色挂 5 张图」才是必须靠图键。两个数一样大，含义完全不同，
   * 而这个函数存在的唯一理由就是区分它们。
   *
   * **空图键不计入**：`imageKeyOf` 认不出的 URL（没有图 / 不是 `/kf/` 图床）算"没有图"，
   * 不是"另一张图"。把它计进去会让「1 张真图 + 2 行缺图」与「3 张不同图」同值，
   * 而前者只需区分 1 个图案。这也与 `variantKeyOf` 的「只有非空图键才追加第 4 段」一致。
   */
  nImages: number;
}

/** 空统计（没采到 SKU 矩阵 / 脏 JSON / 没有行）—— 都是"没算过"，不是"算出来是 0 个" */
const EMPTY: PodLinkStats = { nColors: 0, nImages: 0 };

/** 从一行 SKU 上取色原文（归一只做 `String` + trim，与 `variantColorKey` 的段内归一不同层） */
function colorOf(row: Record<string, unknown>): string {
  const v = row?.color;
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
}

/**
 * 统计一条链接的判别力。
 *
 * 入参是 `pl_shop_items.sku_json` 的**列值**（字符串）；也接受已经解析好的数组
 * （调用方手里就是数组时不必来回 `JSON.stringify`）。**脏输入返回 `{0,0}`，不抛错** ——
 * 这个函数跑在采集落库的热路径上，一条坏快照不该让整帧采集失败；
 * `{0,0}` 的语义是"没算过"（与迁移补列时的默认值同义），下游按"未知"处理，
 * 不会因为读不懂就把它当塌陷链接去做错印风险的重算。
 */
export function podLinkStats(skuJson: unknown): PodLinkStats {
  let rows: unknown;
  if (typeof skuJson === 'string') {
    const s = skuJson.trim();
    if (!s) return { ...EMPTY };
    try {
      rows = JSON.parse(s);
    } catch {
      return { ...EMPTY };
    }
  } else {
    rows = skuJson;
  }
  if (!Array.isArray(rows) || rows.length === 0) return { ...EMPTY };

  // 色名 → 该色名下出现过的图键集合
  const byColor = new Map<string, Set<string>>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const color = colorOf(row);
    let set = byColor.get(color);
    if (!set) {
      set = new Set<string>();
      byColor.set(color, set);
    }
    const img = imageKeyOf(row.imageUrl);
    if (img) set.add(img);
  }
  if (byColor.size === 0) return { ...EMPTY };

  let nImages = 0;
  for (const set of byColor.values()) {
    if (set.size > nImages) nImages = set.size;
  }
  return { nColors: byColor.size, nImages };
}

/**
 * 是不是**色名塌陷**链接（这条链接里至少有一个色名挂着多张图）。
 *
 * 判据只有 `nImages > 1` 一条：它直接对应"3 段键把几个图案并成一个"这件事本身。
 * 计划里写的 `pod_n_colors = 1 AND pod_n_images > 1` 只是它的**极端情形**
 * （整条链接只有一个色名，全塌）；真库此刻 7 条塌陷链接恰好都是这种形状，
 * 但用 `n_colors = 1` 当前提会在"1 个色塌了、另 1 个色正常"的链接上漏判 ——
 * 那种链接同样会错印，只是错一半。
 */
export function isCollapsedLink(stats: PodLinkStats | null | undefined): boolean {
  return Number(stats?.nImages ?? 0) > 1;
}
