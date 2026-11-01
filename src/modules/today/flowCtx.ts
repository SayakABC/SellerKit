// src/modules/today/flowCtx.ts
// 「发货台」各 tab 的共享上下文（容器 `provide`，面板 `inject`）。
//
// 为什么要有它：把四步收进一页多 tab 之后，"谁取数、谁刷谁"必须有**唯一答案**，
// 否则每个面板各取一份 → 出现"导入 tab 说 9 行、拣货 tab 还说 0 行"这类缝。
//
// 分工（**口径唯一**）：
//   · 容器负责**汇总指标**（今天要发几单几件、已拿/还差、未识别款）—— tab 徽标与总览都用这一份；
//   · 各面板负责**自己那一页的业务数据**（拣货面板生成清单、拿货面板取缺口）——
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
  /** `now` = 现在该做这一步；`done` = 已完成；`todo` = 还没轮到（写明在等第几步） */
  state: 'done' | 'now' | 'todo';
  /** 该 tab 尚未内建完（P2/P3 才落地）：只在流程卡上如实标注，不参与"当前步"评选 */
  pending?: boolean;
}

/** 容器统一维护的汇总指标（只含"有没有 / 多少"，不做计算） */
export interface ShippingSummary {
  /** 今天导入的订单行（页签徽标与「导入订单」页共用；`total` = 今天导入的行数） */
  orders: { total: number; collect: number; import: number; lastTime: string };
  /**
   * 「总览」那四个数（2026-10-22）：今天要发几单 / 共几件 / 已拿几件 / 还差几件。
   *
   * 口径与算法**只有一处**：`@/lib/dailyShip`（纯函数，vitest 覆盖）。这里只搬运结果 ——
   * 面板自己再去算一遍就会出现"总览说 21 件、导入页说 16 行"这类只有用户能发现的缝。
   * ⚠️ 已拿 = 逐行覆盖（`purchase_sources.order_item_id` 精确归属）+ 无归属台账按款色码回退；
   *    `estimated` 为真表示后者参与了 ⇒ 界面要说明"含历史拿货，按总量估算"。
   */
  daily: { orders: number; pieces: number; taken: number; remaining: number; estimated: boolean };
  /**
   * 「现在手上还有几单没发」（2026-11-01 T2-2）—— 与上面 `daily` **不是同一批**：
   *
   * `daily` 按**导入日**筛（服务导入/归类两步："今天导的这批"），本项按**当前状态**算
   * （服务早上开机第一问："今天要发几单"）。昨天没发完的单今天还在，所以不能并进 `daily` ——
   * 并进去会出现"待发货 0 但今天要发 12 单"这种自相矛盾的画面。
   *
   * 算法唯一实现在 `@/lib/shippingPulse`（纯函数，vitest 覆盖）；这里只搬结果。
   * ⚠️ `noDeadline > 0` 时界面必须说明"其中 N 单没有截止期"：导入单根本没有这一列，
   *    不说明的话「有截止风险 0」会被读成"都不会超时"。
   */
  pulse: {
    /** 待发货**单数**（按单号去重） */
    pending: number;
    /** 其中 24h 内到截止或**已过期**的单数 */
    risk: number;
    /** 待发货件数（`qty` 缺失按 1 计并计入 `assumedQty`） */
    pieces: number;
    /** 待发货里没有行图的行数 */
    missingImage: number;
    /** 算不出截止风险的单数（没有截止期 / 格式认不出） */
    noDeadline: number;
    /** 件数按 1 兜底的行数 */
    assumedQty: number;
  };
  /**
   * 今天这批里还有多少行没识别出款（「归类核对」页签徽标 + 主线的第 2 步都读它）。
   *
   * ⚠️ 2026-10-22：**只留 style**。原来的缺克重 / 缺成本 / 运价表 / `gapTotal` 只服务
   *    总览那张「钱算得准吗」卡；该卡随总览改版一起撤掉后，这四个数没有任何读者了 ——
   *    留着它们意味着每次刷新白跑 3 次 IPC（产品库 + 价目 + 运价快照）去算没人看的数。
   *    "钱算得准不准"现在只有一处入口：「统计」页（`order-cost`）。
   */
  gaps: { style: number };
  /**
   * 拿货 / 对账侧（2026-10-05 拿货、结算对账两个页签内建后加）。
   *
   * 前四个是**计数**：`orders` 拿货单张数 / `draft` 草稿 / `gap` 待拿货款色数 / `ignored` 已忽略款色数。
   * `balance` 是**金额**（分）且**只此一个** —— 它是"对账那一步做完没有"的唯一判据（还欠着钱 = 对账没完）。
   * ⚠️ 其余金额一律不进这里：对账页自己的四个数（拿货/已付/已退/欠款）**必须同窗口同源**，
   *    从这里混一个"全部窗口的欠款"进去，就会和对账页切到"本月"时显示的欠款打架。
   */
  purchase: { orders: number; draft: number; gap: number; ignored: number; balance: number };
}

export interface ShippingCtx {
  summary: Ref<ShippingSummary>;
  /** 四步主线（容器算、总览与 tab 标记都读这一份 —— 两处各自推导必然出现"卡上当前步 ≠ tab 上当前步"） */
  flow: ComputedRef<FlowStep[]>;
  /** 当前该做的那一步（`now` 里第一个；都在可执行步里选，见容器注释） */
  flowNow: ComputedRef<FlowStep>;
  loading: Ref<boolean>;
  error: Ref<string>;
  /** 数据版本号：变了就 +1（见文件头注释） */
  token: Ref<number>;
  bump(): void;
  /** 切到本页某个 tab —— **不跳页**。流程卡 / 回执里的"下一步"都走它 */
  go(tabId: string): void;
  /**
   * 打开**别的模块**（可带 action 指定落在哪一屏，如 `shop-accounts` + `goods`）。
   */
  openModule(moduleId: string, action?: string): void;
  /** 重新取汇总（刷新按钮 / 导入成功后） */
  reload(): Promise<void>;
  /** 上次导入的回执 —— 写在导入 tab、总览卡要读（`freshOrders` 靠它点亮「待拣」卡） */
  receipt: Ref<AutoImportResult | null>;
  /** 导入动作**只有一处实现**（在容器里）：总览空态的「导入 Excel」与导入页签里的大按钮走同一个函数 */
  importing: Ref<boolean>;
  importExcel(): Promise<void>;
  /**
   * 把用户**拖进投放区**的文件导入（2026-10-11）。
   *
   * 与 `importExcel` 共用容器里的同一条链路（识别 → 落库 → 回执 → `bump`）——
   * 拖放换的只是"字节从哪来"，识别/落库/回执一律不变。`File.name` 只当展示用的来源名，
   * **不进库**（落库的 `sourceFile` 由识别层按同一份 src 决定）。
   */
  importFile(file: File): Promise<void>;
}

/**
 * 「发货台」页签的**显示名**（**唯一来源**：`TodayView.vue` 的页签定义按 id 从这里取）。
 *
 * 为什么把它单独拎出来：多步收进一页多页签之后，页签名成了**新的一类入口名** ——
 * 用户真的点得到它，于是文案里写「去「归类核对」页签」和写「去「货与成本」」是一回事，
 * 都得能对上真东西。`tests/uxEntryNames.spec.ts`（悬空入口名守卫）会读这里的名字当合法入口，
 * 所以**改页签名只改这一处**，别在两处各写一遍。
 *
 * 2026-10-10：原 `picking: '生成拣货单'` 随第 3 步并进「拿货」一并删掉（六步 → 五步）。
 * **不是改名而是这个页签没了** —— 留着它会让悬空名守卫把一个点不到的名字当成合法入口。
 * （拣货清单本身还在，见 `@/modules/picking/PickingView.vue`；它是「拿货」页里的一个视图，
 * 不是页签，所以不进这里。跨模块入口名由 `src/modules/picking/meta.ts` 的 `name` 兜。）
 *
 * 2026-10-17：`cost: '算钱'` 同理删掉 —— 算钱整步撤出本页（归拢到独立模块，并改名「统计」）。
 * 它的入口名此后由 `src/modules/order-cost/meta.ts` 的 `name` 兜（与「货与成本」等真跳转同例）。
 */
export const SHIPPING_TAB_NAMES = {
  overview: '总览',
  import: '导入订单',
  classify: '归类核对',
  purchase: '拿货',
  recon: '结算对账',
} as const;

export const SHIPPING_CTX: InjectionKey<ShippingCtx> = Symbol('shippingCtx');

/**
 * 面板侧取上下文。**解构出来的是顶层 ref**，所以在模板里直接写 `flow` / `summary` 即可
 * （Vue 只对顶层 ref 绑定做自动 unwrap；若写成 `ctx.flow` 就得自己 `.value`）。
 *
 * 不做静默兜底：这些面板只可能挂在「发货台」页的页签里，取不到就是接线错了，
 * 早点报出来比"页签点开一片空白"好排查。
 */
export function useShipping(): ShippingCtx {
  const c = inject(SHIPPING_CTX);
  if (!c) throw new Error('ShippingCtx 未提供：该面板只能挂在「发货台」页的页签里');
  return c;
}
