<template>
  <div class="wb-page td-shell">
    <!-- 页头：标题 + 一句说明 + 刷新。
         说明从"待办清单"改成"这条流程长什么样" —— 五步现在**都在本页的页签里**，
         用户第一眼要知道的是"不用跳页了"，而不是"今天有几件事"。 -->
    <header class="wb-head">
      <div class="wb-head__main">
        <h1 class="wb-head__title">发货台</h1>
        <p class="wb-head__desc">
          每日发货全流程：导入 → 归类 → 算钱 → 拿货 → 对账，五步都在下面的页签里，点页签就地切换
        </p>
      </div>
      <div class="wb-head__actions">
        <button class="wb-btn" data-act="refresh" :disabled="loading" @click="refreshAll">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </div>
    </header>

    <!-- 流程页签：把五步摆成一条可点的线（编号 + 名称 + 这一步还有多少活）。
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
          'is-gap': stateOf(t.id) === 'gap',
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
// 「今天」= **发货台**：把「导入 → 归类 → 算钱 → 拿货 → 对账」五步收进一页多页签。
//
// 为什么这么改（用户 2026-10-05）：原先是四步流程卡，点一步**跳到别的模块**——
// 跳走以后要回来得再点导航，中间的表单/清单全丢，一天几十单的操作里这很磨人。
// 现在：五步 = 五个页签，点击就地切换（`KeepAlive` 保活），页面不重建、列表不重取。
//
// 2026-10-10：原第 3 步「生成拣货单」并进「拿货」（六步 → 五步）—— 拣货清单就是"要拿什么"，
// 与拿货是同一件事的两半（理由详见 `tabs/PurchasePanel.vue` 头注释）。步号整体前移一位。
//
// **本页只做两件事**：① 汇总指标的取数与分发（`ctx.summary`，各页签徽标与总览卡共用同一份）；
// ② 页签切换。**业务算法一律不在这页** —— 仍在 `src/lib/picking.ts` / `src/lib/orderCost.ts`
// 那两处，各面板只调用（用户 2026-09-30 定的原则：数字的算法只有一处）。
import { computed, defineAsyncComponent, onMounted, provide, ref, type Component } from 'vue';
import * as ipc from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import { switchModule } from '@/core/services/shell';
import { selectExcelFile } from '@/core/services/dialog';
import { detectAndImport, type AutoImportResult } from '@/core/services/importSheet';
import { resolveWeightG } from '@/lib/orderCost';
import { loadSkuWeights } from '@/core/services/skuWeights';
import { aggregatePicking, DEFAULT_PICKING_DAYS } from '@/lib/picking';
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
 * 页签定义。顺序 = 流程顺序（与流程卡、与用户说的五步一致）。
 * ⚠️ `defineAsyncComponent` 必须在模块顶层建一次：写进 `computed` 会在每次渲染时新建包装器，
 * 于是 `KeepAlive` 永远认不出"这是同一个组件"，保活失效（切换即重建，等于没做）。
 */
const TABS: TabDef[] = [
  {
    id: 'overview',
    name: TN.overview,
    hint: '现在该做哪一步 + 订单/待拣/缺口三个数字',
    comp: defineAsyncComponent(() => import('./tabs/OverviewPanel.vue')),
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
    id: 'cost',
    name: TN.cost,
    no: '3',
    hint: '按订单行算收入/运费/成本/毛利，缺哪环逐行标出',
    comp: defineAsyncComponent(() => import('./tabs/CostPanel.vue')),
    badge: (s) => (s.gapTotal ? `缺 ${s.gapTotal}` : ''),
  },
  {
    id: 'purchase',
    name: TN.purchase,
    no: '4',
    hint: '要拿什么（图 + 款色码 + 进价）→ 按厂家生成拿货单 → 拿了什么',
    comp: defineAsyncComponent(() => import('./tabs/PurchasePanel.vue')),
    badge: (s) => (s.purchase.gap ? `${s.purchase.gap} 款色` : ''),
  },
  {
    id: 'recon',
    name: TN.recon,
    no: '5',
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

const summary = ref<ShippingSummary>({
  orders: { total: 0, collect: 0, import: 0, lastTime: '' },
  picking: { sku: 0, pieces: 0, orders: 0, missing: 0, days: DEFAULT_PICKING_DAYS },
  gaps: { weight: 0, cost: 0, style: 0, rate: false },
  gapTotal: 0,
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
function openModule(moduleId: string): void {
  switchModule(moduleId);
}

/**
 * 手动刷新 = **作废各面板的缓存**（`token` +1）并重取汇总。
 *
 * ⚠️ 为什么不能只调 `reload()`：`reload()` 只重算页签徽标与总览卡那几个数，
 * 各面板（拣货清单 / 算钱 / 拿货）靠 `token` 变化才知道要重取。只刷汇总的话，
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
 * ⚠️ 前置口径（2026-10-11，用户拍板）：**第 1–3 步看"今天导入的那批"，第 4–5 步看"未结清"**。
 *    所以这里的 `orders` / `gaps` 是**今天**的数（`reload()` 按导入日筛，见那里的注释），
 *    而 `picking` / `purchase` 是跨天的（未发货近 30 天 / 未结清）。这正是"每天上班导一次、
 *    货和钱跨天结转"的真实工作流；两条口径都在界面上写出来了（订单卡的口径标签、
 *    待拣卡的「范围」一行），不要把它们合并成一个数。
 *
 * 五步主线。**只由 `summary` 推导**，不新增取数：
 *   · 第 1 步看 `orders.total`（**今天**导进来多少）
 *   · 第 2 步看 `gaps.style`（今天这批里还有多少行没识别出款）
 *   · 第 3 步看 `gapTotal`（克重/成本/运价齐不齐）
 *   · 第 4 步看 `purchase.gap`（还有多少款色没拿 —— 由订单需求 − 已提交拿货单推出，宿主算好）
 *   · 第 5 步看 `purchase.balance`（还欠厂家多少钱；`0` 才算结清）
 *
 * ⚠️ **串联语义**（2026-10-05 拍图才发现的 bug，别再犯）：前一步没完成时，后面的步骤一律
 *    `todo` + 写明"等第 N 步"，使 `now`+`gap` **恒为 1**。初版各步独立判断 ⇒ 有未识别款时
 *    第 2/3/4 步同时高亮（三块橙边），"当前该做哪一步"这个唯一要回答的问题反而答不出来。
 *    （第 5 步落地后这条约束仍然成立：`wait4` 非空时它必须是 `todo`。）
 *
 * 2026-10-10：原第 3 步「生成拣货单」并进第 4 步「拿货」（六步 → 五步）—— 拣货清单按
 *    厂家/款色码/图/进价汇总，而"拿货"要的正是这张单，两步其实是一件连贯的事（详见
 *    `PurchasePanel.vue` 的头注释）。于是 `picking.sku` **不再是主线的一环**
 *    （它只是总览卡上的一个数字），后面的步号整体前移一位。
 */
const flow = computed<FlowStep[]>(() => {
  const o = summary.value.orders;
  const g = summary.value.gaps;
  const gt = summary.value.gapTotal;
  const pu = summary.value.purchase;
  const hasOrders = o.total > 0;
  const needClassify = hasOrders && g.style > 0;
  const needCost = hasOrders && gt > 0;
  const needPurchase = pu.gap > 0;
  const needRecon = pu.balance !== 0;
  const wait2 = !hasOrders ? '等第 1 步' : needClassify ? '等第 2 步' : '';
  const wait3 = wait2 || (needCost ? '等第 3 步' : '');
  const wait4 = wait3 || (needPurchase ? '等第 4 步' : '');
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
      key: 'cost',
      name: '算钱',
      tab: 'cost',
      act: '去看利润',
      where: '本页「算钱」',
      note: wait2 || (needCost ? `还缺 ${gt} 项数据` : '数据齐了'),
      state: wait2 ? 'todo' : needCost ? 'gap' : 'done',
    },
    {
      no: 4,
      key: 'purchase',
      name: '拿货',
      tab: 'purchase',
      act: '去拿货',
      where: '本页「拿货」',
      note: wait3 || (needPurchase ? `${pu.gap} 款色还差货` : '该拿的都拿了'),
      state: wait3 ? 'todo' : needPurchase ? 'now' : 'done',
    },
    {
      no: 5,
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

/** 当前该做的那一步：在**可执行**的步骤里取第一条 `now`/`gap`；都完成时落在最后一条可执行步 */
const flowNow = computed((): FlowStep => {
  const list = flow.value.filter((s) => !s.pending);
  return list.find((s) => s.state === 'now' || s.state === 'gap') ?? (list[list.length - 1] as FlowStep);
});

/** 导入进行中（按钮的 disabled 与文案读它）—— 必须在 `ctx` 之前声明（对象字面量求值时就要取值） */
const importing = ref(false);

const ctx: ShippingCtx = {
  summary,
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
 * 汇总取数（**本页唯一的取数口**）：三个数字 —— 订单行数 / 待拣 / 数据缺口。
 * 各步的**详细**数据由各面板自己取（拣货面板生成清单、算钱面板跑利润），
 * 这里只回答"有没有 / 多少"，供页签徽标与总览卡使用。
 */
async function reload(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    // 1) 订单：**一个读口**（主干投影；来源由行上的 `source` 区分）
    //
    // ⚠️ **按「导入日」筛今天**（2026-10-11 用户拍板的口径）：每天上班导一次
    //    （"昨天 → 导出时点"的全部订单），白天的追加也**同属今天这批**；
    //    第 1–3 步（导入/归类/算钱）看的就是这批。第 4–5 步（拿货/对账）不按天 ——
    //    货和钱本来就跨天结转，那两步的取数在 `pickingRows` / `purchaseCounts` 里，不走这里。
    //    ⇒ 页签徽标与总览卡上的"还有多少活"因此只说今天这批，与页名「发货台」名实相符。
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

    // 2) 待拣：复用拣货单的**同一份**纯函数（这里只要汇总，不出清单）
    let picking = { sku: 0, pieces: 0, orders: 0, missing: 0, days: DEFAULT_PICKING_DAYS };
    const pk = await ipc.pickingRows({ limit: 2000 });
    if (pk.success && pk.data) {
      const s = aggregatePicking(pk.data.rows, { days: DEFAULT_PICKING_DAYS });
      picking = {
        sku: s.groups.length,
        pieces: s.pieces,
        orders: s.orders,
        missing: s.missingQty + s.missingImage + s.missingSupplier + s.missingStyle,
        days: s.days,
      };
    }

    // 3) 缺口：只查"这项数据在不在"，不算钱
    // 克重只有一个来源（产品库 SKU 表，按款色码）—— 判定与「算钱」同一份函数 `resolveWeightG`，
    // 否则会出现"这页说缺多少行、那页说不缺"（2026-10-01 实报过这类缝）。
    const skuWeights = await loadSkuWeights();
    const missingWeight = all.filter((o) => resolveWeightG(o, skuWeights) === null).length;
    const costs = await ipc.aeCostMapList();
    const coded = new Set(
      (costs.success ? (costs.data ?? []) : [])
        .filter((c) => Number(c.unitPriceCents) > 0)
        .map((c) => String(c.styleCode ?? ''))
    );
    const styled = all.filter((o) => String(o.styleCode ?? ''));
    const rateSnap = await ipc.shipRateSnapshotCalc({ limit: 1 });
    const gaps = {
      weight: missingWeight,
      cost: styled.filter((o) => !coded.has(String(o.styleCode))).length,
      style: all.length - styled.length,
      rate: !!(rateSnap.success && (rateSnap.data?.rows ?? []).length),
    };

    // 4) 拿货：只数**有几个**（几张单 / 几款色还差 / 几款色已忽略）。
    //    金额、差额、店铺分摊属于对账页自己的口径（`purchase-db.reconciliation`），这里不碰 ——
    //    同屏并列的两个数必须同口径，而"拿货单金额"和"对账差额"就不是一回事。
    //    ⚠️ 失败按 0 处理（见 `purchaseCounts` 的注释）：徽标取不到不该让整页汇总挂掉。
    const purchase = await purchaseCounts();

    summary.value = {
      orders,
      picking,
      gaps,
      gapTotal: gaps.weight + gaps.cost + gaps.style + (gaps.rate ? 0 : 1),
      purchase,
    };
  } catch (e: unknown) {
    error.value = `读取失败：${e instanceof Error ? e.message : '未知错误'}`;
    toast(error.value, 'error');
  } finally {
    loading.value = false;
  }
}

onMounted(() => void reload());
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

/* 有数据缺口（如算钱缺 4 项）：左边一条警示色边 */
.td-tab.is-gap::before {
  content: '';
  width: 3px;
  height: 14px;
  margin-left: -4px;
  border-radius: 2px;
  background: var(--wb-warning);
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
