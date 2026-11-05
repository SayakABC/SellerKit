// electron/podRekey.ts
// **塌陷链接的定向重算**（M3·T3-6 的判定层，纯函数、零依赖）。
//
// 要解决的事：存量订单行的 `variant_key` 是 **3 段**（店铺 / 商品ID / 色）。色名塌陷的链接里
// 同一色名下挂着多张**不同的图**，3 段键会把 5~12 个图案并成一件实物 —— 绑图案时被并成 1 个，
// 之后静默错印。第 4 段（图键）就是为这批链接补的（T3-3）。
//
// 三条纪律（按计划 T3-6 的判据，逐条都要能被断言）：
//   ① **只动塌陷链接**：非塌陷链接的行**一个字节都不改**。重算的范围稍一放宽，75 行存量键
//      会整体漂移，而键是"跨表连接"的身份（绑定台账 / 采购映射 / 归类），漂一次要全库对账。
//   ② **已 4 段的不动**：重跑脚本必须幂等（这是脚本，不是迁移，用户会重跑）。
//   ③ **图键认不出就不动**（`imageKeyOf` 认 `/kf/<id>.<ext>`）：那种行**无法拆分**，必须单独计数，
//      让人去补图 —— 静默跳过会让"重算完成"看起来成功，实际这行还是 3 段键。
//
// 为什么摘成纯函数（同 `podLedger` / `podLinkStats`）：`electron/*-db.ts` 的 better-sqlite3 在
// 系统 Node 下进不来，而"哪些行该改、改成什么"正是这一步唯一会算错的地方。

import { imageKeyOf } from './podImageKey';
import { splitVariantKey, variantKeyOf } from './variantKey';

/** 一条待判定的订单行（SQL 侧只负责把三个事实取出来） */
export interface RekeyCandidate {
  orderItemId: number;
  variantKey: string;
  /** 这一行自己的图 URL（`md_images.source_url`；空 = 这行没图/图没落地） */
  imageUrl: string;
  /** 这条链接（店铺 + 商品ID + 色）是否塌陷（`pl_shop_items.pod_n_images > 1`） */
  linkCollapsed: boolean;
}

export interface RekeyUpdate {
  orderItemId: number;
  /** 原键（3 段） */
  fromKey: string;
  /** 新键（4 段，末尾是图键） */
  toKey: string;
  imageKey: string;
}

export interface RekeyPlan {
  /** 要写的行（**只含真正需要改的**） */
  updates: RekeyUpdate[];
  /** 已经是 4 段键（幂等重跑时这些行原样不动） */
  alreadyFour: number;
  /** 非塌陷链接（不在重算范围内，一个字节都不动） */
  notCollapsed: number;
  /** 塌陷链接但认不出图键（无法拆分 —— 必须单独报数，让人补图） */
  cannotSplit: number;
  /** 脏键（空键 / 2 段 / 5 段以上：不是本函数写出来的，不动） */
  dirty: number;
}

/** 链接前缀 = 键的前 3 段（`shop\\0item\\0color`）；脏键返回 '' */
export function linkPrefixOf(key: unknown): string {
  const p = splitVariantKey(key);
  if (!p.itemKey) return '';
  return [p.shopKey, p.itemKey, p.colorKey].join('\u0000');
}

/**
 * 从商品快照摊出的槽位里，收集**塌陷链接**的前缀集合。
 *
 * 判据只有一条：`imgsInName > 1`（同色名下多张不同图）。与 `podLinkStats.isCollapsedLink()`
 * 同一口径 —— 那边看的是链接级统计，这边看的是槽位级事实，两个数都源自同一份 SKU JSON。
 * 不用 `pod_n_colors = 1` 作前提：会漏掉"一个色塌了、另一个色正常"的链接（同样会错印）。
 */
export function collapsedLinkPrefixes(
  slots: readonly { variantKey: string; imgsInName: number }[],
): Set<string> {
  const out = new Set<string>();
  for (const s of Array.isArray(slots) ? slots : []) {
    if (!(Number(s?.imgsInName) > 1)) continue;
    const prefix = linkPrefixOf(s?.variantKey);
    if (prefix) out.add(prefix);
  }
  return out;
}

/**
 * 算出重算方案（**不写库**；写完库再验"非塌陷键集合完全相同、塌陷行数不变"）。
 *
 * @param rows 订单行候选（只应包含 `variant_key <> ''` 的行；空键会被计进 `dirty`）
 */
export function planCollapsedRekey(rows: readonly RekeyCandidate[]): RekeyPlan {
  const plan: RekeyPlan = {
    updates: [],
    alreadyFour: 0,
    notCollapsed: 0,
    cannotSplit: 0,
    dirty: 0,
  };
  for (const r of Array.isArray(rows) ? rows : []) {
    const key = typeof r?.variantKey === 'string' ? r.variantKey : '';
    const parts = splitVariantKey(key);
    if (!parts.itemKey) {
      plan.dirty += 1;
      continue;
    }
    if (parts.imageKey) {
      plan.alreadyFour += 1;
      continue;
    }
    if (r?.linkCollapsed !== true) {
      plan.notCollapsed += 1;
      continue;
    }
    const imageKey = imageKeyOf(typeof r?.imageUrl === 'string' ? r.imageUrl : '');
    if (!imageKey) {
      plan.cannotSplit += 1;
      continue;
    }
    // 用 `variantKeyOf` 重新拼而不是 `key + '\u0000' + imageKey`：
    // 键的拼接只有一处实现，字符串相加会让"段内归一"这条规则悄悄分叉。
    const toKey = variantKeyOf({
      shopKey: parts.shopKey,
      itemKey: parts.itemKey,
      colorKey: parts.colorKey,
      imageKey,
    });
    if (!toKey || toKey === key) {
      plan.cannotSplit += 1;
      continue;
    }
    plan.updates.push({
      orderItemId: Math.round(Number(r?.orderItemId) || 0),
      fromKey: key,
      toKey,
      imageKey,
    });
  }
  return plan;
}
