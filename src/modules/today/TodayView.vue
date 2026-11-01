<template>
  <div class="wb-page td-shell">
    <!-- 页头：标题 + 一句说明 + 刷新。
         说明从"待办清单"改成"这条流程长什么样" —— 四步现在**都在本页的页签里**，
         用户第一眼要知道的是"不用跳页了"，而不是"今天有几件事"。
         ⚠️ 算钱（利润）已**不在本页**（2026-10-17 用户裁定：归拢到独立「统计」页），
            说明里点名它，免得用户在本页找第三个数钱的页签。 -->
    <header class="wb-head">
      <div class="wb-head__main">
        <h1 class="wb-head__title">发货台</h1>
        <p class="wb-head__desc">
          每日发货全流程：导入 → 归类 → 拿货 → 对账，四步都在下面的页签里，点页签就地切换（算钱与利润在「统计」页）
        </p>
      </div>
      <div class="wb-head__actions">
        <button class="wb-btn" data-act="refresh" :disabled="loading" @click="refreshAll">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </div>
    </header>

    <!-- 流程页签：把四步摆成一条可点的线（编号 + 名称 + 这一步还有多少活）。
         ⚠️ 断言钉在 `data-act` 上（`tab-<id>`），不按整段文本匹配。
         ⚠️ 页签上的数字**来自容器统一取的那一份汇总**（`ctx.summary`），不各自取数 ——
            否则会出现"页签说 3 个 SKU、点进去说 0 个"（保活让这份错更隐蔽）。 -->
    <div class="td-tabs" role="tablist" data-act="tabs">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="td-tab"
        :class="{
          'is-on': tab === t.id,
          'is-now': stateOf(t.id) === 'now',
          'is-pending': t.pending,
        }"
        role="tab"
        :aria-selected="tab === t.id"
        :data-act="`tab-${t.id}`"
        :title="t.hint"
        @click="go(t.id)"
      >
        <span v-if="t.no" class="td-tab__no">{{ t.no }}</span>
        <span class="td-tab__name">{{ t.name }}</span>
        <span v-if="badge(t)" class="td-tab__badge" :data-act="`tab-badge-${t.id}`">{{
          badge(t)
        }}</span>
      </button>
    </div>

    <!-- 面板区：**懒挂载 + 保活**。
         `defineAsyncComponent` ⇒ 第一次点这个页签才去加载它的代码；
         `<KeepAlive>` ⇒ 切走不销毁，切回来还是原来那份界面（表单、已生成的清单都还在）
         —— 这正是"丝滑"的来源，也是**必须**配 `token` 的原因（保活会让"旧数据"看起来像"没加载"）。 -->
    <div class="td-panels" data-act="panels">
      <KeepAlive>
        <component :is="activeComp" :key="tab" />
      </KeepAlive>
    </div>

    <p v-if="error" class="td-error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
// 「今天」= **发货台**：把「导入 → 归类 → 拿货 → 对账」四步收进一页多页签。
//
// 为什么这么改（用户 2026-10-05）：原先是四步流程卡，点一步**跳到别的模块**——
// 跳走以后要回来得再点导航，中间的表单/清单全丢，一天几十单的操作里这很磨人。
// 现在：四步 = 四个页签，点击就地切换（`KeepAlive` 保活），页面不重建、列表不重取。
//
// 2026-10-10：原第 3 步「生成拣货单」并进「拿货」（六步 → 五步）—— 拣货清单就是"要拿什么"，
// 与拿货是同一件事的两半（理由详见 `tabs/PurchasePanel.vue` 头注释）。步号整体前移一位。
//
// ⚠️ 2026-10-17：**「算钱」整步撤出本页**（五步 → 四步）。用户裁定："发货台中的算钱步骤去掉，
//    都归拢到算钱菜单中"（该菜单同批改名为「统计」）。判据是这一步**不产生任何写操作**，
//    它只是"看这批订单赚不赚"—— 与发货这条有去有回的流水线不同节奏，嵌在这里反而让
//    "当前该做哪一步"多出一个永远不动的节点。算钱仍只有一份实现（`@/modules/order-cost`），
//    本页连"存在性检查"都不再做了（2026-10-22：那张卡随总览改版撤掉），
//    要点钱 = 真跳「统计」模块（`openModule('order-cost')`），不再是页签。
//
// **本页只做两件事**：① 汇总指标的取数与分发（`ctx.summary`，各页签徽标与总览共用同一份）；
// ② 页签切换。**业务算法一律不在这页** —— 仍在 `src/lib/dailyShip.ts` / `picking.ts` /
// `orderCost.ts` 那几处，各面板只调用（用户 2026-09-30 定的原则：数字的算法只有一处）。
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, provide, ref, type Component } from 'vue';
import * as ipc from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import { switchModule } from '@/core/services/shell';
import { selectExcelFile } from '@/core/services/dialog';
import { detectAndImport, type AutoImportResult } from '@/core/services/importSheet';
import { dailyShip } from '@/lib/dailyShip';
import { shippingPulse, type PulseRow } from '@/lib/shippingPulse';
import { coverageInputs } from '@/lib/orderCoverage';
import { localDayKey } from '@/lib/localDay';
import type { UnifiedOrderRow } from '@/types';
import { purchaseCounts } from './purchase';
import {
  SHIPPING_CTX,
  SHIPPING_TAB_NAMES as TN,
  type FlowStep,
  type ShippingCtx,
  type ShippingSummary,
} from './flowCtx';

interface TabDef {
  id: string;
  name: string;
  /** 流程里的第几步（「总览」不是某一步，故留空） */
  no?: string;
  /** 鼠标悬停的一句话说明 */
  hint: string;
  /** 尚未内建完（当前借道插件）：页签上如实标注，不伪装成"点了没反应" */
  pending?: boolean;
  comp: Component;
  /** 页签上的数字（这一步还有多少活）。返回空串 = 不显示 */
  badge?: (s: ShippingSummary) => string;
}

/**
 * 页签定义。顺序 = 流程顺序（与流程卡、与用户说的四步一致 —— 2026-10-17 算钱整步撤出前是五步）。
 * ⚠️ `defineAsyncComponent` 必须在模块顶层建一次：写进 `computed` 会在每次渲染时新建包装器，
 * 于是 `KeepAlive` 永远认不出"这是同一个组件"，保活失效（切换即重建，等于没做）。
 *
 * 2026-11-01（T2-4）：新增 `queue`「待发货」，位置紧跟「总览」。
 *   · 它**不带步骤号**：四步是"今天导进来的这批怎么走完"，而它是"现在手上还有多少没发"（跨天）；
 *   · 它是总览那块「现在还没发」的**下钻落点**（那块的按钮 `go('queue')` 就切到这里）。
 */
const TABS: TabDef[] = [
  {
    id: 'overview',
    name: TN.overview,
    hint: '今天要发几单、共几件、已拿多少、还差多少',
    comp: defineAsyncComponent(() => import('./tabs/OverviewPanel.vue')),
  },
  {
    id: 'queue',
    name: TN.queue,
    hint: '还没发的单，按最晚发货时间排，最急的在最上面',
    comp: defineAsyncComponent(() => import('./tabs/QueuePanel.vue')),
    // 徽标 = 待发货**单数**（与总览那一格同一个数、同一份来源 `summary.pulse`）
    badge: (s) => (s.pulse.pending ? `${s.pulse.pending} 单` : ''),
  },
  {
    id: 'import',
    name: TN.import,
    no: '1',
    hint: '把平台导出的订单报表导入进来（自动识别文件类型）',
    comp: defineAsyncComponent(() => import('./tabs/ImportPanel.vue')),
    badge: (s) => (s.orders.total ? `${s.orders.total} 行` : ''),
  },
  {
    id: 'classify',
    name: TN.classify,
    no: '2',
    hint: '把订单行归到款式/颜色上（批量识别 + 逐行修正）',
    comp: defineAsyncComponent(() => import('./tabs/ClassifyPanel.vue')),
    badge: (s) => (s.gaps.style ? `${s.gaps.style} 未归类` : ''),
  },
  {
    id: 'purchase',
    name: TN.purchase,
    no: '3',
    hint: '按厂家一卡看完要拿什么（图 + 款色码 + 进价）与已开的单 → 生成拿货单 → 填价提交',
    comp: defineAsyncComponent(() => import('./tabs/PurchasePanel.vue')),
    badge: (s) => (s.purchase.gap ? `${s.purchase.gap} 款色` : ''),
  },
  {
    id: 'recon',
    name: TN.recon,
    no: '4',
    hint: '跟厂家对账（欠款 / 付款）+ 成本按店铺分摊',
    comp: defineAsyncComponent(() => import('./tabs/ReconPanel.vue')),
    badge: (s) => (s.purchase.orders ? `${s.purchase.orders} 单` : ''),
  },
];

const loading = ref(false);
const error = ref('');
const tab = ref('overview');
const token = ref(0);
const receipt = ref<AutoImportResult | null>(null);
/**
 * 「待发货」清单的行源（2026-11-01 T2-4）。
 *
 * 与 `summary.pulse` 是**同一次取数**的两个视角：四数（待发货/快超时/件/缺图）与清单
 * 分别由 `shippingPulse` / `shippingQueue` 算，而后者是前者唯一的实现基础（见 `lib/shippingPulse`）。
 * 各取一次 IPC 的话，"总览说 3 单、清单列 2 行"这种缝迟早出现，且没人能一眼看出哪边对。
 */
const pulseRows = ref<PulseRow[]>([]);

const summary = ref<ShippingSummary>({
  orders: { total: 0, collect: 0, import: 0, lastTime: '' },
  daily: { orders: 0, pieces: 0, taken: 0, remaining: 0, estimated: false },
  pulse: { pending: 0, risk: 0, pieces: 0, missingImage: 0, noDeadline: 0, assumedQty: 0 },
  sync: { last: null, error: '' },
  gaps: { style: 0 },
  purchase: { orders: 0, draft: 0, gap: 0, ignored: 0, balance: 0 },
});

const activeComp = computed<Component>(
  () => (TABS.find((t) => t.id === tab.value) ?? TABS[0]!).comp
);

/** 某个 tab 对应步骤的状态（页签上的"当前步"标记读它；「总览」不算任何一步 ⇒ 空） */
function stateOf(tabId: string): string {
  return flow.value.find((s) => s.tab === tabId)?.state ?? '';
}

function badge(t: TabDef): string {
  return t.badge ? t.badge(summary.value) : '';
}

/** 切到本页某个页签 —— **不跳页**（这是本次改造的核心诉求） */
function go(tabId: string): void {
  tab.value = tabId;
}

/** 打开**别的模块**（「货与成本」这类主数据维护页不属于本流程的某一步，仍是真跳转） */
function openModule(moduleId: string, action?: string): void {
  // `action` = 目标模块里的"落在哪一屏"（如 `shop-accounts` 的 `goods` ⇒ 基础数据 › 货品档案）。
  // 目标模块不在场时 AppShell 把它存进 `__switchModuleAction`，由目标视图 onMounted 消费；
  // 已在场时目标视图自己监听 `switch-module` 接 —— 两条路都在 `MasterDataView.applySwitchAction`。
  switchModule(moduleId, action);
}

/**
 * 手动刷新 = **作废各面板的缓存**（`token` +1）并重取汇总。
 *
 * ⚠️ 为什么不能只调 `reload()`：`reload()` 只重算页签徽标与总览卡那几个数，
 * 各面板（拣货清单 / 拿货 / 对账）靠 `token` 变化才知道要重取。只刷汇总的话，
 * 用户点「刷新」看到徽标变了、点进页签还是旧数据 —— 又变回"两处数字不一致"的老问题。
 * 与 `bump()` 是同一个动作（数据变了 / 用户要求重来，对面板而言没有区别）。
 */
function refreshAll(): void {
  bump();
}

/** 数据变了（导入/生成/提交后）：通知各面板重取，并把汇总也刷一遍 */
function bump(): void {
  token.value += 1;
  void reload();
}

/**
 * 跨模块跳转的落点（2026-10-19）。
 *
 * 别人跳进来时会带一个 `action`：「基础数据 › 待补清单」的「去认款 / 去定色」写的就是
 * `switchModule('today', 'classify')` —— 落到「归类核对」页签，而不是总览。
 *
 * 漏了这一步会怎样：人被送到本页**但停在总览**，还得自己再点一次页签。按钮写着
 * "去认款"、落地是一张总览卡，这就是"指路指到半路"（同 `OverviewPanel` 里那条
 * "只传模块 id 会落在用户上次停留的那一类资料上"）。
 *
 * 两条路都要接（与 `MasterDataView.applySwitchAction` 同一套）：
 *   · 模块**不在场** → AppShell 把 action 存进 `__switchModuleAction`，本视图 `onMounted` 消费；
 *   · 模块**已在场** → AppShell 的 `activateCore` 对同模块早退，marker 不会有人消费
 *     ⇒ 必须自己监听 `switch-module`，否则"从待补清单跳回发货台"这一下**静默没反应**。
 * 消费后清 marker：否则下次从侧栏进来会被一个过期的 action 弹到别的页签。
 */
function applySwitchAction(detail: { moduleId?: string; action?: string } | undefined): void {
  if (!detail || detail.moduleId !== 'today' || !detail.action) return;
  (window as unknown as { __switchModuleAction?: unknown }).__switchModuleAction = null;
  // 认不出的 action 原样不动（宁可停在当前页签，也不把人送进一个不存在的页签）
  if (TABS.some((t) => t.id === detail.action)) tab.value = detail.action as string;
}

function onSwitchModule(e: Event): void {
  applySwitchAction((e as CustomEvent<{ moduleId?: string; action?: string }>).detail);
}

/**
 * ⚠️ 前置口径（2026-10-11，用户拍板）：**第 1–2 步看"今天导入的那批"，第 3–4 步看"未结清"**。
 *    所以这里的 `orders` / `gaps` / `daily` 是**今天**的数（`reload()` 按导入日筛，见那里的注释），
 *    而 `purchase` 是跨天的（未结清）。这正是"每天上班导一次、货和钱跨天结转"的真实工作流；
 *    两条口径都在界面上写出来了（「导入订单」页的计数、总览的口径小字），不要把它们合并成一个数。
 *
 * 四步主线。**只由 `summary` 推导**，不新增取数（页签的 `is-now` 标记读它）：
 *   · 第 1 步看 `orders.total`（**今天**导进来多少）
 *   · 第 2 步看 `gaps.style`（今天这批里还有多少行没识别出款）
 *   · 第 3 步看 `purchase.gap`（还有多少款色没拿 —— 由订单需求 − 已提交拿货单推出，宿主算好）
 *   · 第 4 步看 `purchase.balance`（还欠厂家多少钱；`0` 才算结清）
 *
 * ⚠️ **串联语义**（2026-10-05 拍图才发现的 bug，别再犯）：前一步没完成时，后面的步骤一律
 *    `todo` + 写明"等第 N 步"，使 `now` **恒为 1**。初版各步独立判断 ⇒ 有未识别款时
 *    第 2/3/4 步同时高亮（三块橙边），"当前该做哪一步"这个唯一要回答的问题反而答不出来。
 *
 * 2026-10-10：原第 3 步「生成拣货单」并进第 4 步「拿货」（六步 → 五步）—— 拣货清单按
 *    厂家/款色码/图/进价汇总，而"拿货"要的正是这张单，两步其实是一件连贯的事（详见
 *    `PurchasePanel.vue` 的头注释）。于是 SKU 数**不再是主线的一环**，后面的步号整体前移一位。
 *
 * 2026-10-17：**「算钱」这一步撤出**（五步 → 四步）。它**不写任何数据**、也不是发货的必经动作，
 *    把它挂在这条线上只会让"数据缺口"一直参与"下一步是谁"的推导（数据缺口 ≠ 有活要干）。
 * 2026-10-22：总览改版（四个数）后，原本挂在流线上方的流程卡与三张卡一并撤掉；
 *    这条 `flow` 仍在——**页签左侧的「当前步」标记**（`.td-tab.is-now`）读它，那是页签唯一的
 *    "现在该点哪个"提示，删掉它页签就只剩一排没有主次的按钮。
 */
const flow = computed<FlowStep[]>(() => {
  const o = summary.value.orders;
  const g = summary.value.gaps;
  const pu = summary.value.purchase;
  const hasOrders = o.total > 0;
  const needClassify = hasOrders && g.style > 0;
  const needPurchase = pu.gap > 0;
  const needRecon = pu.balance !== 0;
  const wait2 = !hasOrders ? '等第 1 步' : needClassify ? '等第 2 步' : '';
  const wait3 = wait2 || (needPurchase ? '等第 3 步' : '');
  const wait4 = wait3;
  return [
    {
      no: 1,
      key: 'import',
      name: '导入订单',
      tab: 'import',
      act: '去导入',
      where: '本页「导入订单」',
      note: hasOrders ? `今天导入 ${o.total} 行` : '今天还没导入',
      state: hasOrders ? 'done' : 'now',
    },
    {
      no: 2,
      key: 'classify',
      name: '归类核对',
      tab: 'classify',
      act: '去核对',
      where: '本页「归类核对」',
      note: !hasOrders ? '等第 1 步' : g.style ? `${g.style} 行未识别款` : '款式都识别了',
      state: !hasOrders ? 'todo' : needClassify ? 'now' : 'done',
    },
    {
      no: 3,
      key: 'purchase',
      name: '拿货',
      tab: 'purchase',
      act: '去拿货',
      where: '本页「拿货」',
      note: wait3 || (needPurchase ? `${pu.gap} 款色还差货` : '该拿的都拿了'),
      state: wait3 ? 'todo' : needPurchase ? 'now' : 'done',
    },
    {
      no: 4,
      key: 'recon',
      name: '结算对账',
      tab: 'recon',
      act: '去对账',
      where: '本页「结算对账」',
      note: wait4 || (needRecon ? `还欠 ¥${(pu.balance / 100).toFixed(2)}` : '账已结清'),
      state: wait4 ? 'todo' : needRecon ? 'now' : 'done',
    },
  ];
});

/** 当前该做的那一步：在**可执行**的步骤里取第一条 `now`；都完成时落在最后一条可执行步 */
const flowNow = computed((): FlowStep => {
  const list = flow.value.filter((s) => !s.pending);
  return list.find((s) => s.state === 'now') ?? (list[list.length - 1] as FlowStep);
});

/** 导入进行中（按钮的 disabled 与文案读它）—— 必须在 `ctx` 之前声明（对象字面量求值时就要取值） */
const importing = ref(false);

const ctx: ShippingCtx = {
  summary,
  pulseRows,
  flow,
  flowNow,
  loading,
  error,
  token,
  bump,
  go,
  openModule,
  reload,
  receipt,
  importing,
  importExcel,
  importFile,
};
provide(SHIPPING_CTX, ctx);

/**
 * **导入的唯一实现**（2026-10-11 抽出来）：「选文件」与「拖文件」只是**字节从哪来**不同，
 * 识别 → 落库 → 写回执 → 通知各面板重取，这一整套必须只有一份，否则拖进来的那条路会
 * 慢慢长成"少刷面板 / 不写回执"的半截实现（而它恰恰是**最不容易被点到**的那条路）。
 *
 * ⚠️ 成功/未写入**只留回执卡、不发 toast**（2026-10-11）：回执是常驻的，toast 是几秒即走的
 *    同一句话 —— 两张一起出现只是重复，且 toast 会盖右下角。错误路径仍发 toast（回执装不下）。
 * ⚠️ 重入守卫：导入**不是幂等**操作（同一份报表导两遍 = 订单行翻倍），而投放区"整块可点"，
 *    连点两下很容易发生 —— 进行中一律直接返回。
 */
async function runImport(src: { data: ArrayBuffer; filePath: string }): Promise<void> {
  if (importing.value) return;
  importing.value = true;
  error.value = '';
  try {
    // 上一笔的回执先撤掉：识别 + 落库期间界面上不该还挂着**上一条**结论
    //（用户会把它当成这次的结论；重复导入同类文件时尤其明显 —— 两条 message 长得很像）
    receipt.value = null;
    const r = await detectAndImport(src);
    receipt.value = r;
    // 真写了库才 bump（没写库的文件不改变任何数据，不必让各面板白跑一遍取数）
    if (r.wrote) bump();
    else await reload();
  } catch (e: unknown) {
    const msg = `导入失败：${e instanceof Error ? e.message : '未知错误'}`;
    error.value = msg;
    toast(msg, 'error');
  } finally {
    importing.value = false;
  }
}

/**
 * **选文件导入**（本页两处入口共用）：总览空态的「导入 Excel」与导入页签的投放区都走它。
 *
 * 放在**容器**而不是导入页签里：总览空态的「导入 Excel」点了要能**一步直达选文件**
 * （先切页签再让用户找按钮 = 两次点击，白改）。
 */
async function importExcel(): Promise<void> {
  try {
    const sel = await selectExcelFile();
    if (!sel?.filePath) return;
    await runImport({ data: sel.data, filePath: sel.filePath });
  } catch (e: unknown) {
    const msg = `导入失败：${e instanceof Error ? e.message : '未知错误'}`;
    error.value = msg;
    toast(msg, 'error');
  }
}

/** **拖放导入**：投放区松手 → 读字节 → 走同一条链路（`File.name` 只作展示名） */
async function importFile(file: File): Promise<void> {
  if (importing.value) return;
  try {
    const data = await file.arrayBuffer();
    await runImport({ data, filePath: file.name || '拖入的文件' });
  } catch (e: unknown) {
    const msg = `读取拖入的文件失败：${e instanceof Error ? e.message : '未知错误'}`;
    error.value = msg;
    toast(msg, 'error');
  }
}

/**
 * 汇总取数（**本页唯一的取数口**）：今天这批的四个数（单 / 件 / 已拿 / 还差）+ 未识别款行数 + 拿货的几个徽标数。
 * 各步的**详细**数据由各面板自己取（拣货面板生成清单、拿货面板取缺口），
 * 这里只回答"有没有 / 多少"，供页签徽标与总览使用。
 *
 * 2026-10-22：随总览改版**去掉了三路取数**（`pickingRows` / 产品库克重 / 价目与运价快照）——
 * 它们只服务那张"钱算得准吗"卡，卡撤了之后没有任何读者，留着只是每次刷新多三次 IPC。
 */
async function reload(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    // 1) 订单：**一个读口**（主干投影；来源由行上的 `source` 区分）
    //
    // ⚠️ **按「导入日」筛今天**（2026-10-11 用户拍板的口径）：每天上班导一次
    //    （"昨天 → 导出时点"的全部订单），白天的追加也**同属今天这批**；
    //    第 1–2 步（导入/归类）看的就是这批。第 3–4 步（拿货/对账）不按天 ——
    //    货和钱本来就跨天结转，那两步的取数在 `pickingRows` / `purchaseCounts` 里，不走这里。
    //    ⇒ 页签徽标与总览上的"还有多少活"因此只说今天这批，与页名「发货台」名实相符。
    const imp = await ipc.orderShippingRows({ limit: 2000, importDate: localDayKey() });
    const all: UnifiedOrderRow[] = imp.success && imp.data ? imp.data : [];
    const imported = all.filter((o) => o.source !== 'collect');
    const collected = all.filter((o) => o.source === 'collect');
    const times = all
      .map((o) => String(o.orderTime ?? ''))
      .filter(Boolean)
      .sort();
    const orders = {
      total: all.length,
      import: imported.length,
      collect: collected.length,
      lastTime: times.length ? String(times[times.length - 1]).slice(0, 10) : '',
    };

    // 2) 已拿：**逐行覆盖度**（`purchase-order-coverage`，2026-10-22 起）。
    //    两个数一起用，缺一个都不行：
    //      · `covered`：订单行 id → 已被拿货单覆盖的件数（来自 `purchase_sources.order_item_id`，是事实）；
    //      · `unattributed`：加这一列之前生成的拿货单没有订单归属，按款色码当池子回退。
    //    ⚠️ 两者**互斥**（一件货要么有归属、要么进池子），宿主已经减过，相加不会重复。
    //    ⚠️ 不再读 `purchase-taken` 整条台账：那会把"有归属的"再算一遍，已拿虚高、缺口提前变 0（漏货）。
    //    ⚠️ 失败按"一件没拿"处理：这一屏是**看数**的，取不到不该让整页汇总挂掉
    //       （真拿不准时用户点进「拿货」页签会看到真正的错误）。
    const cv = await ipc.purchaseOrderCoverage();
    const { covered, pool } = coverageInputs(cv.success ? cv.data : null);

    // 3) 四个数：算法在 `@/lib/dailyShip`（纯函数，vitest 覆盖）—— 本页只喂数据。
    //    判定与「拿货」页的「按单核对」清单**同一份实现**（`planCoverage`），
    //    否则总览说"全齐了"、清单说"还差 1 件"是必然会发生的。
    const d = dailyShip(all, { covered, pool });

    // 3b) 「现在手上还有几单没发」（T2-2）：**另取一次全库**，刻意不带 `importDate`。
    //     待发货是跨天的 —— 昨天没发完的单今天还在，按导入日筛会把它们漏掉，
    //     于是"今天要发 0 单"而实际还有 7 单在路上。
    //     `limit: 2000` 对这项够用：SQL 是 `ORDER BY oi.id DESC LIMIT ?`，取的是**最新**的 2000 行，
    //     而未发货的单必然是最近发生的那些（收集箱 5000 单历史不会挤掉它们）。
    //     失败按"全 0"处理：这一屏是看数的，不该让一个副指标把整页汇总挂掉。
    let pulse: ShippingSummary['pulse'] = {
      pending: 0,
      risk: 0,
      pieces: 0,
      missingImage: 0,
      noDeadline: 0,
      assumedQty: 0,
    };
    const pr = await ipc.orderShippingRows({ limit: 2000 });
    if (pr.success && pr.data) {
      pulse = shippingPulse(pr.data);
      // 同一批行也留给「待发货」页签（T2-4）：清单与四数因此不可能来自两次不同的快照。
      // 取不到时**清空**而不是保留上一次的行 —— 留旧行会出现"总览说 0 单、清单还挂着 7 行"。
      pulseRows.value = pr.data;
    } else {
      pulseRows.value = [];
    }

    // 3c) 最近一次芒果同步（T2-3 采集状态条）。
    //     ⚠️ **`success:false` 不许折成 `last: null`**：那会把"读日志失败"显示成"还没同步过"，
    //        而用户对这两件事要做的事完全不同（前者要重装/反馈，后者只要去芒果页面点一下）。
    const st = await ipc.mangoSyncStatus();
    const sync = {
      last: st.success ? (st.data ?? null) : null,
      error: st.success ? '' : String(st.error || '读取同步状态失败'),
    };

    // 4) 未识别款：只服务「归类核对」页签徽标与主线第 2 步（"缺什么"不再在这里算）
    const gaps = { style: all.length - all.filter((o) => String(o.styleCode ?? '')).length };

    // 5) 拿货：只数**有几个**（几张单 / 几款色还差 / 几款色已忽略）。
    //    金额、差额、店铺分摊属于对账页自己的口径（`purchase-db.reconciliation`），这里不碰 ——
    //    同屏并列的两个数必须同口径，而"拿货单金额"和"对账差额"就不是一回事。
    //    ⚠️ 失败按 0 处理（见 `purchaseCounts` 的注释）：徽标取不到不该让整页汇总挂掉。
    const purchase = await purchaseCounts();

    summary.value = {
      orders,
      daily: {
        orders: d.orders,
        pieces: d.pieces,
        taken: d.taken,
        remaining: d.remaining,
        estimated: d.estimated,
      },
      pulse,
      sync,
      gaps,
      purchase,
    };
  } catch (e: unknown) {
    error.value = `读取失败：${e instanceof Error ? e.message : '未知错误'}`;
    toast(error.value, 'error');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  window.addEventListener('switch-module', onSwitchModule as EventListener);
  // 落点先消费（免得用户先看到总览再被弹走），再取数
  applySwitchAction(
    (window as unknown as { __switchModuleAction?: { moduleId?: string; action?: string } })
      .__switchModuleAction
  );
  void reload();
});

onBeforeUnmount(() => {
  window.removeEventListener('switch-module', onSwitchModule as EventListener);
});
</script>

<style scoped>
/* 发货台外壳：页头 + 页签栏固定，面板区自己滚。
   ⚠️ `overflow: hidden` 是**必须**的（覆盖全局 `.wb-page` 的 `overflow: auto`）：
      外层可滚 + 内层（各面板都是整页视图）也可滚 ⇒ 双滚动条，且内层高度算不准，
      「表格被裁掉右半截」这类问题会以最难看的方式出现。滚动只留给最内层。 */
.td-shell {
  overflow: hidden;
  gap: 12px;
}

/* 页签栏：横向可滚（窄窗口下 7 个页签放不下时能滑，而不是被压成两行） */
.td-tabs {
  display: flex;
  flex-shrink: 0;
  align-items: stretch;
  gap: 4px;
  padding: 4px;
  overflow-x: auto;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}

.td-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 7px 12px;
  border: 1px solid transparent;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 13px;
  line-height: 1.2;
  cursor: pointer;
  white-space: nowrap;
}

.td-tab:hover {
  background: var(--wb-hover);
  color: var(--wb-text);
}

/* 选中：白底 + 边框 + 主色文字。**不靠背景色差**（深色主题下那点差读不出来） */
.td-tab.is-on {
  background: var(--wb-surface);
  border-color: var(--wb-border);
  color: var(--wb-primary);
  font-weight: 600;
  box-shadow: var(--wb-elev-1);
}

/* 「当前该做这一步」：左侧一条主色边（与流程卡的 is-now 同一套语言） */
.td-tab.is-now::before {
  content: '';
  width: 3px;
  height: 14px;
  margin-left: -4px;
  border-radius: 2px;
  background: var(--wb-primary);
}

/* 尚未内建完的页签：虚线底边，一眼看出"这个还没做完"，而不是"点了没反应" */
.td-tab.is-pending {
  border-bottom-style: dashed;
  border-bottom-color: var(--wb-border-strong);
}

.td-tab__no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--wb-surface);
  border: 1px solid var(--wb-border);
  color: var(--wb-text-muted);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
}

.td-tab.is-on .td-tab__no {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}

.td-tab__name {
  min-width: 0;
}

/* 页签上的"还有多少活"：数字小而实心，区别于名称 */
.td-tab__badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--wb-surface);
  border: 1px solid var(--wb-border);
  color: var(--wb-text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

/* 面板区：占满剩余高度，滚动交给面板自己 */
.td-panels {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.td-error {
  margin: 0;
  flex-shrink: 0;
  font-size: 13px;
  color: var(--wb-danger);
}
</style>
