// src/modules/today/flowCtx.ts
// 「发货台」各 tab 的共享上下文（容器 `provide`，面板 `inject`）。
//
// 为什么要有它：把六步收进一页多 tab 之后，"谁取数、谁刷谁"必须有**唯一答案**，
// 否则每个面板各取一份 → 出现"导入 tab 说 9 行、拣货 tab 还说 0 行"这类缝。
//
// 分工（**口径唯一**）：
//   · 容器负责**汇总指标**（订单 / 待拣 / 缺口）—— tab 徽标与总览卡都用这一份；
//   · 各面板负责**自己那一页的业务数据**（拣货面板生成清单、算钱面板跑利润）——
//     算法仍在 `src/lib/*` 那一处，面板只调用；
//   · 任何"让数据变了"的动作（导入 / 生成 / 提交）后调 `bump()`：`token` +1，
//     各面板 `watch(token)` 重取 ⇒ 切回该 tab 看到的就是新数据（保活不再等于"看到旧的"）。
import { inject, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import type { AutoImportResult } from '@/core/services/importSheet';

/** 发货主线的一步（界面只读；状态由汇总数字推导，不引入新取数） */
export interface FlowStep {
  no: number;
  key: string;
  name: string;
  /** 这一步现在什么情况（一句话，带数字） */
  note: string;
  /** 在哪做（人话名；现在都在这页的 tab 里） */
  where: string;
  /** 「下一步」按钮的文案 */
  act: string;
  /** 切到本页哪个 tab —— ⚠️ 不是模块 id：改造后点它**不跳页** */
  tab: string;
  state: 'done' | 'now' | 'gap' | 'todo';
  /** 该 tab 尚未内建完（P2/P3 才落地）：只在流程卡上如实标注，不参与"当前步"评选 */
  pending?: boolean;
}

/** 容器统一维护的汇总指标（只含"有没有 / 多少"，不做计算） */
export interface ShippingSummary {
  orders: { total: number; collect: number; import: number; lastTime: string };
  picking: { sku: number; pieces: number; orders: number; missing: number; days: number };
  gaps: { weight: number; cost: number; style: number; rate: boolean };
  gapTotal: number;
  /**
   * 拿货 / 对账侧（2026-10-05 拿货、结算对账两个页签内建后加）。
   *
   * 前四个是**计数**：`orders` 拿货单张数 / `draft` 草稿 / `gap` 待拿货款色数 / `ignored` 已忽略款色数。
   * `balance` 是**金额**（分）且**只此一个** —— 它是"第 6 步做完没有"的唯一判据（还欠着钱 = 对账没完）。
   * ⚠️ 其余金额一律不进这里：对账页自己的四个数（拿货/已付/已退/欠款）**必须同窗口同源**，
   *    从这里混一个"全部窗口的欠款"进去，就会和对账页切到"本月"时显示的欠款打架。
   */
  purchase: { orders: number; draft: number; gap: number; ignored: number; balance: number };
}

export interface ShippingCtx {
  summary: Ref<ShippingSummary>;
  /** 六步主线（容器算、总览与 tab 标记都读这一份 —— 两处各自推导必然出现"卡上当前步 ≠ tab 上当前步"） */
  flow: ComputedRef<FlowStep[]>;
  /** 当前该做的那一步（`now`/`gap` 里第一个；都在 4 个可执行步里选，见容器注释） */
  flowNow: ComputedRef<FlowStep>;
  loading: Ref<boolean>;
  error: Ref<string>;
  /** 数据版本号：变了就 +1（见文件头注释） */
  token: Ref<number>;
  bump(): void;
  /** 切到本页某个 tab —— **不跳页**。流程卡 / 回执里的"下一步"都走它 */
  go(tabId: string): void;
  /** 打开**别的模块**（如「货与成本」这类主数据维护页，不属于本流程的某一步） */
  openModule(moduleId: string): void;
  /** 重新取汇总（刷新按钮 / 导入成功后） */
  reload(): Promise<void>;
  /** 上次导入的回执 —— 写在导入 tab、总览卡要读（`freshOrders` 靠它点亮「待拣」卡） */
  receipt: Ref<AutoImportResult | null>;
  /** 导入动作**只有一处实现**（在容器里）：总览空态的「导入 Excel」与导入页签里的大按钮走同一个函数 */
  importing: Ref<boolean>;
  importExcel(): Promise<void>;
}

/**
 * 「发货台」页签的**显示名**（**唯一来源**：`TodayView.vue` 的页签定义按 id 从这里取）。
 *
 * 为什么把它单独拎出来：六步收进一页多页签之后，页签名成了**新的一类入口名** ——
 * 用户真的点得到它，于是文案里写「去「归类核对」页签」和写「去「货与成本」」是一回事，
 * 都得能对上真东西。`tests/uxEntryNames.spec.ts`（悬空入口名守卫）会读这里的名字当合法入口，
 * 所以**改页签名只改这一处**，别在两处各写一遍。
 */
export const SHIPPING_TAB_NAMES = {
  overview: '总览',
  import: '导入订单',
  classify: '归类核对',
  picking: '生成拣货单',
  cost: '算钱',
  purchase: '拿货',
  recon: '结算对账',
} as const;

export const SHIPPING_CTX: InjectionKey<ShippingCtx> = Symbol('shippingCtx');

/**
 * 面板侧取上下文。**解构出来的是顶层 ref**，所以在模板里直接写 `flow` / `summary` 即可
 * （Vue 只对顶层 ref 绑定做自动 unwrap；若写成 `ctx.flow` 就得自己 `.value`）。
 *
 * 不做静默兜底：这些面板只可能挂在「今天」页的页签里，取不到就是接线错了，
 * 早点报出来比"页签点开一片空白"好排查。
 */
export function useShipping(): ShippingCtx {
  const c = inject(SHIPPING_CTX);
  if (!c) throw new Error('ShippingCtx 未提供：该面板只能挂在「今天」页的页签里');
  return c;
}
