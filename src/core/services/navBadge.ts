// src/core/services/navBadge.ts
// 侧栏**模块入口徽标**的渲染层登记表（唯一出处）。
//
// ---- 它和 subNav.ts 的分工 ----
//   · `subNav.ts`：**模块内部**的二级项（由模块自己上报，模块不在场就没有该项）；
//   · 本文件：**模块一级入口**上的数字（邮件未读）。数字由主进程算好推来
//     （`nav-badge` 广播，见 `electron/ui-bridge.ts`），因为"未读"在收件箱模块
//     根本没被打开时也存在 —— 让模块自己上报的话，冷启动不进邮件页就永远没有角标，
//     而这恰好是最需要它的时刻（后台收到了新信）。
//
// ---- 两条纪律 ----
// ① **只存不推**：本文件不算数、不猜数，`reportNavBadge` 收到什么就是什么。
//    数值口径只有主进程一处（`mailStats().unread`）。
// ② **缺席不是 0**：`count: null` 表示"撤掉徽标"，直接从表里删键；侧栏据此**不渲染**。
//    画一个 0 会让"没事了"和"还有 0 件"长得一样（与 `SubNavItem.count` 同一约定）。

import { ref } from 'vue';

export interface NavBadge {
  /** null = 撤掉（不渲染徽标） */
  count: number | null;
  /** 悬停说明（"3 封未读邮件"） */
  title?: string;
  /** 待办性质：> 0 时用警示色 */
  todo?: boolean;
}

/**
 * 登记表：模块 id → 徽标。
 * 整体替换（而不是 `reactive(new Map())`）是刻意与 `subNav.ts` 对齐的：赋值即通知，
 * 没有"改 Map 的某个方法追踪不到"这类模糊地带。
 */
const BADGES = ref<Record<string, NavBadge>>({});

/** 上报/撤销某模块的徽标（`badge = null` 或 `count: null` 都表示撤销） */
export function reportNavBadge(moduleId: string, badge: NavBadge | null): void {
  const id = String(moduleId || '').trim();
  if (!id) return;
  const next = { ...BADGES.value };
  if (!badge || badge.count === null || badge.count === undefined) {
    delete next[id];
  } else {
    next[id] = badge;
  }
  BADGES.value = next;
}

/** 读某模块的徽标（没有 = `undefined`，侧栏不画） */
export function navBadgeOf(moduleId: string): NavBadge | undefined {
  return BADGES.value[moduleId];
}

/** 清空（外壳卸载 / 测试收尾用） */
export function clearNavBadges(): void {
  BADGES.value = {};
}
