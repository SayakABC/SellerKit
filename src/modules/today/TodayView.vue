<template>
  <div class="wb-page td-shell">
    <!-- 页头：标题 + 一句说明 + 刷新。
         说明从"待办清单"改成"这条流程长什么样" —— 四步现在**都在本页的页签里**，
         用户第一眼要知道的是"不用跳页了"，而不是"今天有几件事"。
         ⚠️ 2026-11-02：第 1 步的「导入订单」页签并进「待发货」—— 主入口是芒果采集，
            Excel 导入退成页内的备选区。说明句按这个顺序写，免得用户又去别处找"导入"。
         ⚠️ 算钱（利润）已**不在本页**（2026-10-17 用户裁定：归拢到独立「统计」页），
            说明里点名它，免得用户在本页找第三个数钱的页签。 -->
    <header class="wb-head">
      <div class="wb-head__main">
        <h1 class="wb-head__title">发货台</h1>
        <!-- 说明句（2026-11-05 重写）：这句话现在是**定位**，不是流程目录。
             用户原话：「发货台准确的定位应该是发货前的准备工作，准备完成，就代表这个订单
             已经完成了准备」。所以先说"把单准备好"，再当场划清边界"发货在芒果点" ——
             不写后半句，用户会在这一页找"发货"按钮，而这一页根本没有那个能力。
             两个旁路（订花纸按需 / 利润在统计）各自在页签与模块名上就能看到，不再占这一行。 -->
        <p class="wb-head__desc">
          把待发货的订单准备好（补图 / 归类 / 拿货）；发货在芒果点
        </p>
      </div>
      <div class="wb-head__actions">
        <button class="wb-btn" data-act="refresh" :disabled="loading" @click="refreshAll">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </div>
    </header>

    <!-- 页签栏：**没有步号，也没有"当前步"标记**（2026-11-05 起）。
         步号暗示"必须整批按顺序做完第 1 步才轮到第 2 步"，而真实处境是四类活同时压在
         四张不同的单上（A 单差件、B 单已齐、C 单缺图、D 单没认出色）—— 那个标记答的是
         "整批"，用户问的是"我这几单"。引导改由「订单」屏的状态分组承担。
         ⚠️ 断言钉在 `data-act` 上（`tab-<id>`），不按整段文本匹配。
         ⚠️ 页签上的数字**来自容器统一取的那一份汇总**（`ctx.summary`），不各自取数 ——
            否则会出现"页签说 3 个 SKU、点进去说 0 个"（保活让这份错更隐蔽）。 -->
    <div class="td-tabs" role="tablist" data-act="tabs" @keydown="onTabKey">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="td-tab"
        :class="{ 'is-on': tab === t.id }"
        role="tab"
        :aria-selected="tab === t.id"
        :tabindex="tab === t.id ? 0 : -1"
        :data-act="`tab-${t.id}`"
        :title="t.hint"
        @click="go(t.id)"
      >
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
// 「今天」= **发货台**：把「订单 → 归类 → 拿货 → 对账」收进一页多页签。
//
// 为什么这么改（用户 2026-10-05）：原先是四步流程卡，点一步**跳到别的模块**——
// 跳走以后要回来得再点导航，中间的表单/清单全丢，一天几十单的操作里这很磨人。
// 现在：各屏 = 页签，点击就地切换（`KeepAlive` 保活），页面不重建、列表不重取。
//
// 2026-11-05（用户原话「怎么才能以订单维度来跟踪当前订单的状态…现在的流程感觉是相对独立的」）：
//   · 「总览」+「待发货」合并成「订单」（D-1），**步号 1–4 取消**（D-2）；
//   · 「全局串行流程」模型（`flow`）删除 —— 它是"看不太明白"的结构性来源，见下面那段注释。
//   · 本页的定位从此写在页头：**把待发货的订单准备好，发货在芒果点**。
//
// **本页只做两件事**：① 汇总指标的取数与分发（`ctx.summary`，各页签徽标与订单屏共用同一份）；
// ② 页签切换。**业务算法一律不在这页** —— 仍在 `src/lib/dailyShip.ts` / `shippingPulse.ts` /
// `orderStage.ts` / `picking.ts` / `orderCost.ts` 那几处，各面板只调用（用户 2026-09-30 定的原则：
// 数字的算法只有一处）。
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  type Component,
} from 'vue';
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
  type ShippingCtx,
  type ShippingSummary,
} from './flowCtx';

interface TabDef {
  id: string;
  name: string;
  /** 鼠标悬停的一句话说明 */
  hint: string;
  comp: Component;
  /** 页签上的数字（这一屏还有多少活）。返回空串 = 不显示 */
  badge?: (s: ShippingSummary) => string;
}

/**
 * 页签定义（2026-11-05：六个 → 五个，且**全部去掉步号**）。
 * ⚠️ `defineAsyncComponent` 必须在模块顶层建一次：写进 `computed` 会在每次渲染时新建包装器，
 * 于是 `KeepAlive` 永远认不出"这是同一个组件"，保活失效（切换即重建，等于没做）。
 *
 * 变化与理由：
 *   · 「总览」+「待发货」**合并成「订单」**（用户拍板 D-1）：两屏回答的其实是同一个问题
 *     （"我有几单、是哪几单"），只差聚合与明细；分成两屏是历史包袱，用户还得自己对照。
 *   · 步号 1/2/3/4 **取消**（用户拍板 D-2）：流程是每单并行，"第 N 步"暗示整批顺序完成。
 *   · 「订单」排第一并作为默认落点：它是这一页的**主屏**，其余四个是围着它转的工具。
 */
const TABS: TabDef[] = [
  {
    id: 'orders',
    name: TN.orders,
    hint: '每张待发货订单准备到哪一档（缺图 / 待归类 / 待拿货 / 已备齐），展开看明细行',
    comp: defineAsyncComponent(() => import('./tabs/OrderPanel.vue')),
    // 徽标 = 待发货**单数**（与订单屏那句「合计 N 单待发货」同一个数、同一份来源 `summary.pulse`）
    badge: (s) => (s.pulse.pending ? `${s.pulse.pending} 单` : ''),
  },
  {
    id: 'classify',
    name: TN.classify,
    hint: '把订单行归到款式/颜色上（批量识别 + 逐行修正）',
    comp: defineAsyncComponent(() => import('./tabs/ClassifyPanel.vue')),
    badge: (s) => (s.gaps.style ? `${s.gaps.style} 未归类` : ''),
  },
  {
    id: 'pod',
    name: TN.pod,
    hint: '要发货的件数 − 手上还剩的花纸 = 这次补多少件（再折算成要订几张）；可以直接复制成图片发给花纸厂',
    comp: defineAsyncComponent(() => import('./tabs/PodOrderPanel.vue')),
  },
  {
    id: 'purchase',
    name: TN.purchase,
    hint: '按厂家一卡看完要拿什么（图 + 款色码 + 进价）与已开的单 → 生成拿货单 → 填价提交',
    comp: defineAsyncComponent(() => import('./tabs/PurchasePanel.vue')),
    badge: (s) => (s.purchase.gap ? `${s.purchase.gap} 款色` : ''),
  },
  {
    id: 'recon',
    name: TN.recon,
    hint: '跟厂家对账（欠款 / 付款）+ 成本按店铺分摊',
    comp: defineAsyncComponent(() => import('./tabs/ReconPanel.vue')),
    badge: (s) => (s.purchase.orders ? `${s.purchase.orders} 单` : ''),
  },
];

const loading = ref(false);
const error = ref('');
const tab = ref('orders');
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
/** 「芒果订单已同步」事件的退订函数（挂载时订阅，卸载时释放） */
let offMango: (() => void) | null = null;

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

function badge(t: TabDef): string {
  return t.badge ? t.badge(summary.value) : '';
}

/** 切到本页某个页签 —— **不跳页**（这是本次改造的核心诉求） */
function go(tabId: string): void {
  tab.value = tabId;
}

/**
 * 页签的键盘动线（2026-11-05）：`role="tablist"` 在浏览器里**不自带**行为，
 * 只标 role 而不实现 ←/→ 等于对外承诺了却做不到（读屏用户按方向键没反应）。
 *
 * 改的是 `tabindex`（roving tabindex）：只有当前页签在 Tab 序列里，
 * 否则 Tab 要穿过 5 个页签才能到面板 —— 那才是键盘用户真正的负担。
 */
function onTabKey(e: KeyboardEvent): void {
  const i = TABS.findIndex((t) => t.id === tab.value);
  if (i < 0) return;
  let next = -1;
  if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
  else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = TABS.length - 1;
  if (next < 0) return;
  e.preventDefault();
  const target = TABS[next];
  if (!target) return;
  go(target.id);
  // 切完把焦点送过去：`KeepAlive` 换面板不会动焦点，不送的话焦点还留在原来那个按钮上
  void nextTick(() => {
    const el = document.querySelector<HTMLElement>(`[data-act="tab-${target.id}"]`);
    el?.focus();
  });
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
 * ⚠️ 前置口径（2026-10-11，用户拍板，**仍然成立**）：`orders` / `gaps` / `daily` 是**今天**的数
 *    （`reload()` 按导入日筛，服务采集与归类），而 `purchase` 是跨天的（未结清）。
 *    两条口径在界面上各自写出来了（订单屏「今天进来」那行 vs「合计 N 单待发货」），不要合并成一个数。
 *
 * 2026-11-05：**「全局串行流程」（`FlowStep` / `flow` / `flowNow`）整块删除**。
 *    它用四个聚合数推导"现在该做第几步"（`now` 恒为 1 步），隐含假设是"整批走完一步才进下一步"。
 *    真实处境是四类活同时压在四张不同的单上，串行模型答不了"我这几单"，只会让页签那点 3px
 *    标记变成噪音。现在"从哪开始"由「订单」屏的状态分组回答，而且它答的是**每一单**。
 *    删掉之后这里少了一条每次 `summary` 变化都要重算的推导，也少了一处"卡上当前步 ≠ tab 上当前步"的隐患。
 */

/** 导入进行中（按钮的 disabled 与文案读它）—— 必须在 `ctx` 之前声明（对象字面量求值时就要取值） */
/** 导入进行中（按钮的 disabled 与文案读它）—— 必须在 `ctx` 之前声明（对象字面量求值时就要取值） */
const importing = ref(false);

/**
 * 「订单」屏 → 「归类核对」的**带单号跳转**（2026-11-05）。
 * 只在两屏之间传一个单号，不搬运行数据（归类页自己按单号搜，口径与手打一致）。
 */
const classifyFocus = ref('');

/**
 * 「订单」屏 → 「拿货」的**带款色跳转**（2026-11-05）。
 * 拿货页是几十行款色宫格，只说"去拿货"等于把人丢进去自己找 —— 这里把哪一单、哪一款色、
 * 还差几件带过去，拿货页据此高亮并滚到那一行（不做过滤：过滤会把同厂其它要拿的藏起来）。
 */
const purchaseFocus = ref<ShippingCtx['purchaseFocus']['value']>(null);

/**
 * 逐行覆盖度（2026-11-05）：**容器取一次，订单屏与「今天进来」共用**。
 *
 * `ok=false` 表示这一次没读到 —— 订单屏据此把判不出来的单落「待核对」，
 * 而不是折成"一件没拿"（会让用户重复下单）或"已经齐了"（会少发一批货）。
 */
const coverage = ref<ShippingCtx['coverage']['value']>({
  covered: {},
  pool: {},
  ok: false,
});

const ctx: ShippingCtx = {
  summary,
  pulseRows,
  coverage,
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
  classifyFocus,
  purchaseFocus,
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
    //    2026-11-05：同一份结果也交给「订单」屏（`coverage`），但**带上 `ok`** ——
    //       订单屏要把"这次没读到"显示成「待核对」，而不是"一件没拿"或"已经齐了"。
    const cv = await ipc.purchaseOrderCoverage();
    const cin = coverageInputs(cv.success ? cv.data : null);
    const { covered, pool } = cin;
    coverage.value = { covered, pool, ok: !!cv.success };

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
  // 芒果采集是**外部进程**（Chrome 扩展）写库，本页无从感知 —— 接收端处理完一批就广播，
  // 这里据此走 `bump()`（= 重取汇总 + 作废各面板缓存），用户点完「去芒果采集」不必再手动刷新。
  // ⚠️ **`ok:false` 也要刷**：抓 0 条 / 登录过期时采集状态条必须立刻变红，藏到下次手动刷新等于没说。
  offMango = ipc.onMangoIngested(() => bump());
  void reload();
});

onBeforeUnmount(() => {
  window.removeEventListener('switch-module', onSwitchModule as EventListener);
  offMango?.();
  offMango = null;
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

/* 2026-11-05：**「当前步」标记（`.td-tab.is-now`）与「步号」（`.td-tab__no`）随
   "全局串行流程"一起删掉**。理由是它答错了问题：那个标记答"整批走到第几步"，
   而用户问的是"我这几单各自到哪了"（现在由「订单」屏的状态分组回答）。
   一个答不对问题的提示，比没有提示更贵 —— 它让用户以为这页只有一条主线。
   ⚠️ 别再照着旧实现加回来：`.td-tab__no` 曾是"空心环"、徽标是"实心胶囊"，
      那一整套形状分离（2026-11-03 方案 §5.10）是为了区分"序号 vs 数量"；
      序号没了，这套区分也就没有对象了。 */

.td-tab__name {
  min-width: 0;
}

/* 页签上的"还有多少活"：实心胶囊。
   ⚠️ 去掉边框：边框是**控件**语言（可点的框），填充是**数据**语言（一个量）。
      页签本身已经是可以点的按钮了，徽标再画一圈边，就成了"按钮里套按钮"。
   2026-11-05：左侧的"步号"删掉后，这颗胶囊就是页签行上唯一的数字 —— 它现在是
      "这一屏还有多少活"的唯一读数，不再是"序号 vs 数量"的形状对立的一半。 */
.td-tab__badge {
  flex-shrink: 0;
  padding: 1px 6px 2px;
  border-radius: 999px;
  background: var(--wb-hover);
  color: var(--wb-text);
  font-size: var(--wb-fs-micro);
  font-weight: 600;
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
