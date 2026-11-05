// src/core/services/subNav.ts
// 模块内部的**二级导航上报口**（2026-10-17 为「基础数据」七类资料而建）。
//
// ── 为什么要有它 ──────────────────────────────────────────────────────────
// 「基础数据」是一个模块，里面七个面（店铺账号 / 货品档案 / 店铺登记 / 企业 / 供应商 /
// 成本与费率 / 物流运费）过去靠页面内一条 200px 的左导航切换。那 200px 是**从内容区里扣的**：
// 它加上栏间距 12 共 212px 不再属于内容区，默认 1200 窗口下右内容只剩 744px ——
// 而「货品档案」的两栏工作台下限之和是 836px（见 `docs/notes/2026-10-30-goods-ux-refactor.md`
// 里记的那次被迫抬断点）。侧栏本来就有 208px 是"已经付出"的宽度，把这七个面挪进去等于免费。
//
// ── 为什么是"运行时上报"，不是 meta 里声明 ─────────────────────────────────
// 三项内容里有两项**只有模块自己知道实时值**：
//   · 徽标（未归一的店名数 / 缺进价的款数）—— 每次进页面重算，还会随用户刚登记完一家店而变；
//   · 当前停在哪一项 —— 它是模块的 `store.mainTab`（持久化），侧栏无权也不该去读另一个模块的 store。
// 所以约定反过来：**模块把自己的菜单报上来，外壳只负责画**。meta 里只留一个布尔
// `subNav: true`（见 `types.ts` 的 `ModuleMeta.subNav`）—— 它的唯一用途是"模块还没打开过时，
// 侧栏也画得出展开箭头"，不复制任何内容。
//
// ── 三条硬约束 ────────────────────────────────────────────────────────────
// 1. **只上报、不自渲染**：本文件不碰 DOM。侧栏展开与否、缩进、徽标配色全在 `AppShell.vue`。
// 2. **items / activeId 是 getter 不是快照**：模块内的计数一变，侧栏要跟着变，不能让模块
//    自己 watch 一遍再手推（那是必然漏一处的活儿）。必须是 getter，外壳在 computed 里调用，
//    Vue 的依赖追踪才跟得住 —— 传 `ref` 或普通数组都会变成"进页面时那一瞬"的僵值。
// 3. **卸载不清**：模块切走时子项列表保留（展开与否由外壳按 `activeId` 判断，所以视觉上仍是
//    "切走自动收起"）。清掉的话，用户再点回来会先看到一行孤零零的「基础数据」闪一下再展开。
import { ref } from 'vue';
// 图标词汇直接用 `icons.ts` 的 `IconName`（不是 `ModuleIcon`）：二级项是**模块内部的**图标，
// 由模块用 `IconGlyph` 画 —— 而 `iconSvg()` 那套字符串表只有 7 个内置（shiedl/factory/coins/truck
// 全落不到，会一起退化成同一个箱子），用它等于七项长一个样。
import type { IconName } from '../components/icons';

/** 一个二级项（侧栏缩进行） */
export interface SubNavItem {
  /** 稳定 id：同时是 `data-act="<prefix>-<id>"` 的后半段与跨模块跳转的 `action` 值 */
  id: string;
  name: string;
  icon?: IconName;
  /**
   * 徽标数字。`null` / `undefined` = **不渲染徽标**（读不到数时别拿 0 冒充"没有"——
   * 那会让"还没数完"和"确实是零"看起来一样，用户会误以为清完了）。
   */
  count?: number | null;
  /** 徽标 tooltip（说明这个数是什么） */
  countTitle?: string;
  /** 徽标是"待办"性质：`> 0` 时用警示色 */
  todo?: boolean;
}

/** 模块上报给外壳的二级导航状态 */
export interface SubNavState {
  /** 子项清单（getter，见文件头约束 2） */
  items: () => SubNavItem[];
  /** 当前停在哪一项（getter） */
  activeId: () => string;
  /**
   * 点某一项时调它。**由模块自己实现**：它才知道要不要校验 id、
   * 要不要顺手 reload 一遍徽标（答案通常是"要"）。
   */
  onSelect: (id: string) => void;
}

/**
 * 注册表：模块 id → 状态。
 *
 * 用 `ref` 装整个对象并**整体替换**（`{ ...prev, [id]: next }`）而不是 `reactive(new Map())`：
 * 后者在 Vue 3 里对 `set` 的追踪依赖 `shallowReactive` 的细节，读改一处就容易漏响应；
 * 整体替换是"赋值即通知"，没有模糊地带。
 */
const REGISTRY = ref<Record<string, SubNavState>>({});

/** 模块上报（覆盖式；模块重新挂载时再报一次即可，无需先清） */
export function reportSubNav(moduleId: string, state: SubNavState): void {
  REGISTRY.value = { ...REGISTRY.value, [moduleId]: state };
}

/** 读某个模块的二级导航（未上报过 = `undefined`：模块还从没打开过） */
export function subNavOf(moduleId: string): SubNavState | undefined {
  return REGISTRY.value[moduleId];
}

/**
 * 仅测试用：清空注册表。
 *
 * 单测里多个用例共享模块级 `ref`，不清会**跨用例串味**（上一个用例报的七项还在，
 * 下一个用例断言"没上报时没有子项"就恒红）。生产代码不该调它。
 */
export function __resetSubNavForTest(): void {
  REGISTRY.value = {};
}
