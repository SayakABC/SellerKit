// 「店铺商品池」的取数与交互逻辑 —— 由两个**渲染形态**共用：
//   · `components/PoolPane.vue`        —— 两栏工作台右栏（列裁剪，见方案 §7-2）
//   · `components/SkuMappingView.vue`  —— 整宽单栏（`GOODS_LAYOUT='tabs'` 的回退形态）
//
// 与 `useProductList` 同由来的理由：这里的逻辑（队列实时聚合 + 已映射分页筛选 /
// 批量与改绑**一次提交** + 三层回落取图 + 看图弹层 + 标失效 / 恢复）约 450 行，
// 抄一份的代价不是"多 450 行"，而是**两处会漂** —— 回退路径（`tabs`）没有任何冒烟覆盖，
// 抄出来的那一份错了不会有人发现，等真要回退时才发现回退不了。
// 两个组件的差别只在**模板**（列怎么排、状态放哪），逻辑只此一处。
//
// ⚠️ 改这里等于同时改两套界面。行为变更要两个形态都过一遍 `goods:ui`（跑的是 `PoolPane`）
//    ＋ 手动切 `GOODS_LAYOUT='tabs'` 看一眼（回退形态没有冒烟）。
//
// 三条口径由主进程裁定，本文件只呈现、**不自己算**（迁移时一条都没动）：
//   1. 队列是**实时聚合** `oi_orders` 的商品ID 再减去已生效映射，不是缓存表 ——
//      所以每次写入完成后都要重新拉队列，「关联完就从队列里消失」才是真实状态；
//   2. `店铺未归一` 的行**不给**关联按钮：订单里没有平台字段，平台只能从店铺实体取，
//      拿空平台硬塞会把不同平台的两家店并到同一个键上。这类行只能先去店名归一；
//   3. 批量关联**一次提交整批**（主进程单事务 + 行级失败逐行回来），不做逐条调用 ——
//      首次导入 500 行未命中是常态，逐条会把 IPC 往返变成瓶颈。

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as api from './api';
import * as shopApi from './shopApi';
import { pickImage } from './productIo';
import { toast } from '@/core/services/toast';
import { switchModule } from '@/core/services/shell';
import { aeReceiverStatus, onAeItemsIngested, openExternal } from '@/core/services/ipc';
import type {
  AeReceiverStatus,
  ItemImagePoolEntry,
  ShopItemRow,
  ShopItemSummaryRow,
  ShopListItem,
  ShopSkuRow,
  SkuMapInputPayload,
  SkuQueueRow,
  SkuQueueStats,
  SkuMapSummary,
} from '@/types';

/** 队列首屏组数；「显示更多」每次追加这么多（主进程单次上限 1000） */
const QUEUE_STEP = 200;
const QUEUE_MAX = 1000;
/** 已映射列表每页条数 */
export const MAPPED_PAGE_SIZE = 50;

/** 映射状态 → 中文标签 / 标签样式类（两个形态共用同一份，避免两处各写一张表） */
export const SKU_STATUS_LABEL: Record<string, string> = {
  confirmed: '已确认',
  pending: '待确认',
  invalid: '已失效',
};
export const SKU_STATUS_CLASS: Record<string, string> = {
  confirmed: 'is-on',
  pending: 'is-warn',
  invalid: '',
};
export const SKU_SOURCE_LABEL: Record<string, string> = {
  manual: '手工',
  import: '导入',
  ai_suggest: '智能建议',
};

/** 左栏「当前款」—— 用户真的展开过的那一行（见 `ProductPane` 的 `expandedId` 注释） */
export interface SelectedProduct {
  id: number;
  code: string;
  name: string;
}

/**
 * 待认行的来源。
 * · `order`  —— 订单侧实时聚合（`oi_orders` 按「店铺 × 商品ID」聚合，减去已生效映射）
 * · `scrape` —— 采集侧快照（`pl_shop_items`，含手贴；只列未认款）
 */
export type PendingOrigin = 'order' | 'scrape';

/**
 * 待认清单的**统一行** —— 把上面两个来源映射成同一个形状。
 *
 * 为什么要这层（见 `docs/plans/GOODS_TAB_REDESIGN_2026-10-25.md` §3）：右栏原先按**来源**分两段，
 * 用户得先判断"我要找的那条来自哪"才能开工。合并成一段之后，"来源"降级为行内标签，
 * 分段按**状态**分（待认 / 已认）—— 用户关心的是"还差多少"，不是"这些从哪来"。
 *
 * ⚠️ **视图合并 ≠ 写路径合并**：`queueRow` / `itemRow` 各自保留原行，提交时仍由
 * `queueWriteRows` / `itemWriteRows` 分别构造（两个来源的字段归属不同），再拼成一个数组
 * 交给 `commitMap` —— 一次 IPC、一个事务、一套失败语义。
 */
export interface PendingRow {
  /** 稳定键：订单行 `o:<店铺归一键>\0<商品ID>`，采集行 `i:<快照行 id>` */
  key: string;
  origin: PendingOrigin;
  /** 来源标签（展示）：订单 / 采集 / 手贴 */
  originLabel: string;
  itemId: string;
  shopId: number;
  /** 店铺展示名：已登记用店名；未登记时订单用原文、采集用归一店名 */
  shopLabel: string;
  platform: string;
  /** 缩略图 dataUrl / 远程地址；`''` = 没有图（渲染空占位，不猜） */
  thumb: string;
  /**
   * 图池键（**归一后**的商品ID；采集行恒空串 —— 它的图直接来自 CDN 地址）。
   *
   * ⚠️ 不能用 `itemId`：那是订单原文（可能带空格），图池的键是归一的，
   * 拿原文挂锚点/查图必然落空且不报错 —— 症状是"整列没图，但看起来像这些订单本来就没图"。
   */
  thumbKey: string;
  /** 订单行的「疑似店铺」提示（同名唯一精确命中给出，永不自动落库）；采集行恒空串 */
  autoShopHint: string;
  /** 图注（来源说明 / 店名）—— 图是认款的主要依据，没图时必须一眼看得出来 */
  thumbSource: string;
  /** 能写映射吗（不能则复选框禁用 + 说清原因，而不是给个灰按钮了事） */
  canRelate: boolean;
  /** 不能写的原因（`canRelate` 为真时是空串） */
  blockedReason: string;
  /** 副行补充：订单行 = 「卖出 N 笔」；采集行 = 「SKU N 条」（没有则空串，模板显示「未采集」） */
  extra: string;
  /**
   * SKU 矩阵条数（订单行恒 0）。
   *
   * ⭐ 2026-10-28（用户口径"SKU 改只展示数量，不要全部列出来"）：待认表副行的可用宽度
   * 只有 ~300px，十几色矩阵摊进去会把店铺/平台挤掉、行高撑成两行 —— 看起来就是
   * "展示不全"。所以**只看数字**，色码全文降为 `skuText` 挂 `title`（悬停仍可核对）。
   * 数量口径与 `itemSkuCount()` 同一函数，不在模板里另算。
   */
  skuCount: number;
  /**
   * 采集行采到的 SKU 色/码文本（订单行恒空串）。
   *
   * ⚠️ 2026-10-28 起它**不再直接渲染成文本**，只作 `extra` 的 `title`（全文）。
   * 别再把它接回副行 —— 那一版在右栏 518px 下必然挤成两行，用户已报过两次"太长"。
   */
  skuText: string;
  /** 原始行（提交时取用；两者必有且仅有一个非空） */
  queueRow: SkuQueueRow | null;
  itemRow: ShopItemRow | null;
}

export interface SkuPoolOptions {
  /**
   * 页级「刷新」按钮的信号：值一变就重拉（传 getter，调用方不要自己 watch）。
   * 与左栏 `useProductList` 同一条管线 —— 页级「刷新」应当刷新**同屏**的每一栏。
   */
  refresh?: () => number;
  /**
   * 左栏的「当前款」（分栏才有的东西）。
   *
   * 给了它，队列工具栏才会出现「关联到 `<款编码>`」的**直连**入口 —— 分栏之后
   * 款与商品同屏，「选款 → 勾商品 → 直连」比"勾商品 → 开弹层 → 搜款 → 选"少两步。
   * 不给（整宽回退形态 `SkuMappingView` 就是这样）就没有这个入口：没有可看见的落点，
   * 给一个"关联到某个你屏幕上找不到的款"的按钮只会让人写错款。
   */
  selectedProduct?: () => SelectedProduct | null;
  /**
   * 首屏分段。默认 `'queue'`（整宽回退形态 `SkuMappingView` 的历史行为，别动它）；
   * 两栏形态 `PoolPane` 传 `'pending'` —— 合并段要**同时**拉队列与采集快照，
   * 首屏设对了，`onMounted` 的那次 `refreshAll` 才会两源一起拉。
   */
  initialSub?: SkuSub;
  /**
   * 存量补图真的补上了（>0 张）时回调 —— 外壳据此重拉**同屏两栏**。
   *
   * 补的是**产品主数据**（`pl_products.image_id`），而左栏的产品列表归 `useProductList` 自己管；
   * 不通知它，用户会看到"提示说补了 4 张，左栏还是白图"（进度与画面自相矛盾）。
   * 整宽回退形态不传（它没有左栏）。
   */
  onImagesAdopted?: () => void;
}

/** 右栏分段。`pending` = 待认（订单 + 采集合并，仅两栏形态）；其余为整宽形态的三个历史段 */
export type SkuSub = 'queue' | 'items' | 'mapped' | 'pending';

export function useSkuPool(opts: SkuPoolOptions = {}) {
  /**
   * 当前分段：待关联队列（订单侧实时聚合）/ 待关联采集商品（采集侧快照，只列未认款）/
   * 已建立映射。三个段各是一种状态的家，同一个商品不会同时出现在两段。
   *
   * 第三段 `items` 是 2026-10-13 加的（AE_SHOP_ITEM_SYNC_PLAN P2）：同一个认款动作的
   * **第三个输入源**。整宽回退形态（`SkuMappingView`）不渲染它的按钮，`sub` 也不会变成
   * `'items'` —— 回退路径是兼容形态，不为它补一套UI（补了也没冒烟兜底）。
   */
  const sub = ref<SkuSub>(opts.initialSub ?? 'queue');
  const loading = ref(false);
  const busy = ref(false);
  const error = ref('');
  const failures = ref<{ itemId: string; message: string }[]>([]);

  /* ---- 队列 ---- */
  const queueRows = ref<SkuQueueRow[]>([]);
  const qStats = ref<SkuQueueStats | null>(null);
  const queueLimit = ref(QUEUE_STEP);
  const selectedKeys = ref<Set<string>>(new Set());

  /* ---- 映射表 ---- */
  const mappedRows = ref<ShopSkuRow[]>([]);
  const mappedTotal = ref(0);
  const mPage = ref(1);
  const mSummary = ref<SkuMapSummary | null>(null);
  const mSearchInput = ref('');
  const mSearch = ref('');
  const mStatus = ref('');
  const mShop = ref('');
  /**
   * 「只看当前款」的筛选（`0` = 不过滤）—— P2 · S4 从**左栏行展开区**搬来的能力。
   *
   * 原来左栏展开一款就按 `skuList({productId})` 反查"这款关联了哪些店铺商品"。
   * 展开区撤掉后，同一件事在这里做：已认段本来就是全量映射视图，加一个按款过滤即可，
   * 不必再维护第二份读数（那正是 P2 要消掉的"同屏重复"）。
   *
   * ⚠️ 存的是 **id**，不是款编码：编码可以改，而它是展示用的标签（本仓的老规矩）。
   */
  const mProduct = ref(0);

  /* ---- 店铺商品采集快照（第三段；AE_SHOP_ITEM_SYNC_PLAN P1/P2）---- */
  const itemRows = ref<ShopItemRow[]>([]);
  const itemTotal = ref(0);
  const itemPage = ref(0);
  const itemSummary = ref<ShopItemSummaryRow[] | null>(null);
  /** 接收端运行状态（状态条用；`null` = 还没问到） */
  const receiverStatus = ref<AeReceiverStatus | null>(null);
  /** 勾选键 = 快照行 id（字符串）。商品ID 会跨店重复，不能当键 */
  const itemSelected = ref<Set<string>>(new Set());

  /* ---- 建款向导（从采集商品新建款并关联；方案 §4.3）---- */
  /** 正在建档的快照行；`null` = 向导关着 */
  const wizardItem = ref<ShopItemRow | null>(null);
  const wizardBusy = ref(false);
  const wizardError = ref('');
  /** 结构化回执（审查 P1-3：三个 IPC 三个事务，做不到"单事务回滚"，就给可重入 + 说清做了什么）。
   *  图片两段（P4）同样是"成了说成、没成说为什么"——下载失败进 mainImageError，不当异常。 */
  const wizardReceipt = ref<{
    productId: number;
    productCode: string;
    variantsWritten: number;
    variantsFailed: number;
    related: boolean;
    /** 主图采纳：'adopted' 已采纳 / 'skipped' 没勾选或没图 / 'failed' 下载失败。
     *  （没有 'reused'：向导只建新档，新档必然没有主图 ⇒ 要么采纳要么失败；
     *   "采集行早有本地图不重复下载"是主进程的复用事实，不进回执。） */
    mainImage: 'adopted' | 'skipped' | 'failed';
    mainImageError: string;
    /** 色图采纳统计（bound = 绑到款色上的张数；其余说清为什么没绑） */
    colorImages: { bound: number; skipped: number; failed: number };
  } | null>(null);

  const picker = ref<
    | { mode: 'queue'; queue: SkuQueueRow[] }
    | { mode: 'items'; items: ShopItemRow[] }
    | { mode: 'pending'; rows: PendingRow[] }
    | { mode: 'rebind'; row: ShopSkuRow }
    | null
  >(null);
  const pendingInvalidate = ref<ShopSkuRow | null>(null);
  /** 对比认款弹层；`null` = 关着。它只回答"该关联到哪一款"，写库仍走 `commitMap` */
  const compare = ref<{ row: SkuQueueRow } | null>(null);

  /**
   * 左栏的「当前款」（`null` = 没选款）—— 直连与对比的落点。
   *
   * ⚠️ 用 `watch` 同步到本地 ref，**不要**写成 `computed(() => opts.selectedProduct?.())`：
   * option 是个**普通函数**，`computed` 在求值时调它并不会建立依赖 ⇒ 左栏从"没选款"
   * 变成"选了某款"时它**不会重算**（症状是"直连按钮死活不出现"，而同文件里别的 watch 却
   * 一切正常 —— 因为它们的 getter 读的是响应式 ref）。走 `watch` 才会真读进调用方那个 ref。
   */
  const currentProduct = ref<SelectedProduct | null>(null);
  watch(
    () => opts.selectedProduct?.() ?? null,
    (v) => {
      currentProduct.value = v;
    },
    { immediate: true }
  );

  const unresolvedShops = computed(() => qStats.value?.unresolvedShops ?? []);
  const shopOptions = computed(() => mSummary.value?.byShop ?? []);
  const hasQueueHints = computed(
    () =>
      unresolvedShops.value.length > 0 ||
      !!qStats.value?.truncated ||
      (qStats.value?.withoutItemId ?? 0) > 0
  );

  const selectableQueue = computed(() => queueRows.value.filter((r) => r.status === 'unmapped'));
  const allQueueChecked = computed(
    () =>
      selectableQueue.value.length > 0 &&
      selectableQueue.value.every((r) => selectedKeys.value.has(queueKey(r)))
  );
  const someQueueChecked = computed(
    () => !allQueueChecked.value && selectableQueue.value.some((r) => selectedKeys.value.has(queueKey(r)))
  );
  const selectedUnmapped = computed(() =>
    selectableQueue.value.filter((r) => selectedKeys.value.has(queueKey(r)))
  );

  const mappedPages = computed(() => Math.max(1, Math.ceil(mappedTotal.value / MAPPED_PAGE_SIZE)));
  const mappedFiltered = computed(
    () => !!mSearch.value || !!mStatus.value || !!mShop.value || mProduct.value > 0
  );

  /**
   * 关联率 = 已关联组数 / 全部组数。
   * 分母用 `groups`（主进程保证 = 已关联 + 待关联 + 店铺未归一）而不是"已确认映射条数"：
   * 后者会算进**已经没有订单**的历史映射，比率会虚高到看不出问题。
   */
  const rateText = computed(() => {
    const g = qStats.value?.groups ?? 0;
    if (!g) return '—';
    const m = qStats.value?.mapped ?? 0;
    return `${Math.round((m / g) * 100)}%（${m}/${g}）`;
  });

  /**
   * 队列里的**待办总数** = 未关联 + 店铺未归一。
   *
   * ⚠️ 不能用 `stats.groups` 代替它：`groups` 是**聚合出的全部组**（含已经关联好的那一半），
   * 拿它去和 `shown` 比会**恒真** —— 于是渲染出一个"点了纹丝不动"的「显示更多」。
   * 实测：认完两行之后队列只剩 1 行，按钮却还在，点下去行列数一个都不变（本仓既有结论
   * 里的"假动作"）。`unmapped + shopUnresolved` 才是"队列里还有多少组"，与列表实现同源。
   */
  const queuePendingTotal = computed(
    () => (qStats.value?.unmapped ?? 0) + (qStats.value?.shopUnresolved ?? 0)
  );
  /** 还有**没列出来**的组 —— 判据 = 待办总数 > 本页返回的行数 */
  const queueHasMore = computed(() => (qStats.value?.shown ?? 0) < queuePendingTotal.value);

  /** 队列行的稳定键（主进程按 `(店铺归一键, 商品ID)` 聚合，这里用同一对） */
  function queueKey(r: SkuQueueRow): string {
    return `${r.shopKey}\u0000${r.itemId}`;
  }

  /**
   * 「批量关联选中 N 项…」的按钮文案（W4）。
   *
   * ⚠️ **单项时不说「批量」**：批量是一个承诺（一次写多行、一次事务、一次回执），
   * 只有 1 行的时候它什么都没兑现，反而让用户以为自己勾错了（"我明明只点了一个，怎么成了批量"）。
   *
   * 为什么这句放钩子里而不是两个模板各写一遍：同一句话在整宽形态与工作台右栏**都要出现**，
   * 复制两份之后必然有一天只改一份 —— 本仓"同一个意思两套文案"的老毛病（UX-G1 同源）。
   */
  const batchLabel = computed(() =>
    selectedUnmapped.value.length === 1
      ? '关联选中 1 项…'
      : `批量关联选中 ${selectedUnmapped.value.length} 项…`
  );

  /* ---- 店铺商品段的派生量 ---- */

  /** 可勾选的行：店铺已登记（有平台才能写映射）且还没认过款 */
  const selectableItems = computed(() =>
    itemRows.value.filter((r) => r.shopId > 0 && !!r.platform && !r.mappedProductId)
  );
  const itemSelectedRows = computed(() =>
    itemRows.value.filter((r) => itemSelected.value.has(String(r.id)))
  );
  const itemAllChecked = computed(
    () =>
      selectableItems.value.length > 0 &&
      selectableItems.value.every((r) => itemSelected.value.has(String(r.id)))
  );
  const itemSomeChecked = computed(
    () => !itemAllChecked.value && selectableItems.value.some((r) => itemSelected.value.has(String(r.id)))
  );

  /**
   * 状态条三个数：已采 / 已认款 / 最近采集。
   * 全库汇总（summary 是每家店一行，不随当前页过滤）—— 与 `invalidCount` 同一个纪律：
   * `null`（还没问到）算 0，但**渲染层据此区分"没采过"与"采了 0 个"**。
   */
  const itemStats = computed(() => {
    const rows = itemSummary.value ?? [];
    let total = 0;
    let confirmed = 0;
    let lastScrapedAt = 0;
    for (const r of rows) {
      total += r.total;
      confirmed += r.confirmed;
      if (r.lastScrapedAt > lastScrapedAt) lastScrapedAt = r.lastScrapedAt;
    }
    // 未认款数 = 分段徽标用的（2026-10-16 起本段**只列未认款**，徽标再报"采了多少"
    // 会与列表行数对不上 —— 用户看到"徽标 3、表里 2 行"只会以为漏了数据）。
    // 与 summary 的 confirmed 同源（主进程同一条 EXISTS 判据），不自己从行数算。
    return { total, confirmed, unmapped: Math.max(0, total - confirmed), lastScrapedAt };
  });

  /** 还没登记的采集桶（store_key 即展示名）—— 警告条与队列 `unresolvedShops` 同构 */
  const unresolvedItemStores = computed(() =>
    (itemSummary.value ?? []).filter((r) => r.shopId === 0).map((r) => r.storeKey).filter((s) => !!s)
  );

  /**
   * 「未登记店铺」**合并名单**（2026-11-03 界面方案 §5.1）。
   *
   * 原先并排两条几乎一模一样的橙条（订单侧 / 采集侧各一条）：根因同一个（店铺没登记）、
   * 出口同一个（店名归一），两句只差"卖出去的 / 采回来的"。同屏两处警告会把警告色变成
   * 背景噪音 —— 真正"还差多少"反而不显眼。合并后一条报**并集数量** + 两侧各自的后果。
   *
   * ⚠️ 口径是**取并集，不是相加**：两侧唯一能用来对齐的就是店名（这些店正因为"没登记"，
   *    压根没有可比的 `shopId`）；同名只算一次，否则"1 家店"会被报成"2 家"。
   *    同一个店两侧写法不同时会算成两家 —— 这是诚实的：那两个串本来就对不上，
   *    而对上它们正是要用户去「店名归一」做的事。
   * ⚠️ 顺序：订单侧在前（队列是用户当下正在处理的那一段），采集侧在后。
   */
  const unresolvedShopsAll = computed(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of [...unresolvedShops.value, ...unresolvedItemStores.value]) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  });

  /** 两侧是否各有未登记店铺 —— 决定合并后那句话说**哪几种后果**（没遇到的事不替用户说） */
  const unresolvedHasOrder = computed(() => unresolvedShops.value.length > 0);
  const unresolvedHasItems = computed(() => unresolvedItemStores.value.length > 0);

  /** 合并提示条的悬停长解释：两侧的"为什么必须先登记"各自不同，按实际有的一侧拼 */
  const unresolvedHintTitle = computed(() => {
    const parts: string[] = [];
    if (unresolvedHasOrder.value) {
      parts.push('订单里没有平台字段，平台只能从已登记的店铺取 —— 先到「店名归一」登记这些店，这几行才能写映射');
    }
    if (unresolvedHasItems.value) {
      parts.push('到「店名归一」把店铺地址一填，之后的采集自动归位，这些商品就能认款了');
    }
    return parts.join('；');
  });

  /**
   * 手贴商品ID导入（保底通道：扩展选择器全落空时，用户从后台复制商品ID贴进来）。
   * 数据层走与采集帧**同一个写路径**（`importManualItems` → `upsertShopItems`），
   * 只是 source='manual'，表上和"采来的"分得开。shopId=0 = 落未登记桶。
   */
  const manualImportOpen = ref(false);
  const manualImportShopId = ref(0);
  const manualImportText = ref('');
  const manualImportBusy = ref(false);
  const manualImportError = ref('');
  const manualImportShops = ref<ShopListItem[]>([]);

  function openManualImport() {
    manualImportOpen.value = true;
    manualImportShopId.value = 0;
    manualImportText.value = '';
    manualImportError.value = '';
    void loadManualImportShops();
  }
  function closeManualImport() {
    if (manualImportBusy.value) return;
    manualImportOpen.value = false;
  }
  async function loadManualImportShops() {
    try {
      const r = await shopApi.list({ limit: 500 });
      manualImportShops.value = r?.rows ?? [];
    } catch {
      manualImportShops.value = [];
    }
  }
  /** 把文本框拆成商品ID列表：按换行 / 逗号 / 空白 / 制表符切，去空、去重。 */
  function parseManualIds(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of text.split(/[\n,，\s]+/)) {
      const id = part.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }
  async function submitManualImport() {
    const ids = parseManualIds(manualImportText.value);
    if (!ids.length) {
      manualImportError.value = '请先粘贴商品ID（每行一个，或用逗号/空格分隔）';
      return;
    }
    manualImportBusy.value = true;
    manualImportError.value = '';
    try {
      const r = await api.shopItemsImport({ shopId: manualImportShopId.value, ids });
      if (!r) throw new Error('导入无返回');
      const msg =
        `已接收 ${r.received} 条：新增 ${r.inserted}，更新 ${r.updated}` +
        (r.skipped ? `，跳过 ${r.skipped}（空/非ID）` : '');
      toast(msg, r.inserted + r.updated > 0 ? 'success' : 'info');
      manualImportOpen.value = false;
      manualImportText.value = '';
      await loadShopItems();
    } catch (e) {
      manualImportError.value = e instanceof Error ? e.message : '导入失败';
    } finally {
      manualImportBusy.value = false;
    }
  }

  /* ---- 「打开店铺」下拉（items 段工具条）：去某家店的卖家后台采商品 ---- */

  /** 已登记店铺（下拉打开时拉；`null` = 还没拉过） */
  const openShopList = ref<ShopListItem[] | null>(null);
  const openShopError = ref('');

  /** 每次打开下拉都重拉 —— 店铺可能刚在「店名归一」里改过（本页没有别的途径感知） */
  async function loadOpenShopList(): Promise<void> {
    openShopError.value = '';
    try {
      const r = await shopApi.list({ limit: 500 });
      openShopList.value = r?.rows ?? [];
    } catch (e: unknown) {
      openShopList.value = [];
      openShopError.value = e instanceof Error ? e.message : '读取店铺失败';
    }
  }

  /**
   * 下拉每一行 = 店铺 + 它的采集统计（`itemSummary` 按 shopId 对上；没采过的 stat 为 null）。
   * 排序：最近采过的排前面（要再打开的通常就是这些店），其余按名字。
   */
  const openShopRows = computed(() => {
    const statByShop = new Map<number, ShopItemSummaryRow>();
    for (const r of itemSummary.value ?? []) {
      if (r.shopId > 0) statByShop.set(r.shopId, r);
    }
    return (openShopList.value ?? [])
      .map((shop) => ({ shop, stat: statByShop.get(shop.id) ?? null }))
      .sort(
        (a, b) =>
          (b.stat?.lastScrapedAt ?? 0) - (a.stat?.lastScrapedAt ?? 0) ||
          a.shop.name.localeCompare(b.shop.name, 'zh')
      );
  });

  /**
   * 在浏览器打开店铺主页（去采集）—— 优先 Chrome，没装才回落系统默认浏览器。
   *
   * 用 `openExternal`（open-external 通道）而不是 `<a target="_blank">` —— 主窗口对新窗口
   * 一律 deny（静默），页面锚点在这类入口上点了毫无反应（店名归一页 2026-10-16 修的就是这个坑）。
   * 成功 toast 带一句**下一步**：采集按钮在扩展的弹窗里，这一页的表格等广播自动刷新；
   * 失败多半是地址填错，提示改的地方（「店名归一」）。
   */
  async function openShopNow(shop: ShopListItem): Promise<void> {
    if (!shop.shopUrl) return;
    try {
      const r = await openExternal(shop.shopUrl);
      if (!r.success) {
        toast(`${r.error || '打开失败'} —— 到「店名归一」修正这家店的地址`, 'error');
        return;
      }
      toast(
        `已在浏览器打开「${shop.name}」——到店后点扩展的「采集本店全部（含 SKU）」，采到的商品会自动出现在这里`,
        'success'
      );
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : '打开失败', 'error');
    }
  }

  /** SKU 矩阵条数（详情页重采才有；列表轻采 = '—'）。解析失败按 0 条，不抛 */
  function itemSkuCount(r: ShopItemRow): number {
    if (!r.skuJson) return 0;
    try {
      const v = JSON.parse(r.skuJson);
      return Array.isArray(v) ? v.length : 0;
    } catch {
      return 0;
    }
  }

  /**
   * SKU 矩阵的**行内展示文本**：「黑/L、4/M」（色/码相接，码空时只留色名）。
   *
   * 表格里只放文本、不放编辑器：右栏只有 ~500px，矩阵动辄十几行，摊进行里没法看。
   * 这一列回答"采到了哪些色码"；**修改的唯一入口是产品编辑抽屉**（2026-10-23 合并，
   * 采集段只认款）—— 与产品列表"只读格 ≠ 可编辑格"同一条纪律。
   * 解析失败 / 空矩阵返回 ''（调用方显示「未采集」），不抛。
   */
  function itemSkuText(r: ShopItemRow): string {
    if (!r.skuJson) return '';
    try {
      const v = JSON.parse(r.skuJson);
      if (!Array.isArray(v)) return '';
      return v
        .map((s: { color?: string; size?: string }) => {
          const c = String(s?.color ?? '').trim();
          const z = String(s?.size ?? '').trim();
          if (c && z) return `${c}/${z}`;
          return c || z;
        })
        .filter((s: string) => !!s)
        .join('、');
    } catch {
      return '';
    }
  }

  const pickerTitle = computed(() => {
    const t = picker.value;
    if (t?.mode === 'queue' || t?.mode === 'items' || t?.mode === 'pending') {
      const n = t.mode === 'queue' ? t.queue.length : t.mode === 'items' ? t.items.length : t.rows.length;
      // 同 `batchLabel`：单项时不说「批量」。弹层标题比按钮多带一个数字，
      // 因为它要回答"我这就要写几行"。
      return n === 1 ? '关联 1 项到产品' : `批量关联 ${n} 项到产品`;
    }
    return '改绑到产品';
  });
  const pickerConfirm = computed(() => {
    const t = picker.value;
    if (t?.mode === 'queue') return `关联这 ${t.queue.length} 项`;
    if (t?.mode === 'items') return `关联这 ${t.items.length} 项`;
    if (t?.mode === 'pending') return `关联这 ${t.rows.length} 项`;
    return '改绑';
  });
  /** 改绑时预填原色（`spec` 即颜色，`'*'`/空 = 未指定）—— 不预填会把人配好的颜色冲成"未指定" */
  const pickerInitialColor = computed(() => {
    const t = picker.value;
    if (!t || t.mode !== 'rebind') return '';
    const s = String(t.row.spec ?? '').trim();
    return s && s !== '*' ? s : '';
  });

  /* ---- 取数 ---- */

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  watch(mSearchInput, (v) => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      mSearch.value = v.trim();
      mPage.value = 1;
      void loadMapped();
    }, 300);
  });
  onBeforeUnmount(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });
  watch([mStatus, mShop, mProduct], () => {
    mPage.value = 1;
    void loadMapped();
  });
  /** 切回队列视图时重拉一次：停在映射页期间别处可能改了店铺归一，表单锚点会失效 */
  watch(sub, (v) => {
    if (v === 'queue') void loadQueue();
    if (v === 'items') void loadShopItems();
    // 合并段同时列两源：少拉一边就是"切换段落后少了半张表"
    if (v === 'pending') {
      void loadQueue();
      void loadShopItems();
    }
  });
  /** 「只看未认款」一翻就重拉（服务端过滤，见 handler 注释） */
  async function loadQueue(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      const res = await api.skuQueue({ limit: queueLimit.value });
      queueRows.value = res?.rows ?? [];
      qStats.value = res?.stats ?? null;
      // 每次重拉都清空选择：行会整批消失（刚关联完），留着旧键会指向不存在的行
      selectedKeys.value = new Set();
      // 拉完行才能知道要取哪些图（图不挡列表渲染：整列先空占位，拿到再填）
      void loadQueueThumbs();
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  async function loadMapped(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      const [list, sum] = await Promise.all([
        api.skuList({
          offset: (mPage.value - 1) * MAPPED_PAGE_SIZE,
          limit: MAPPED_PAGE_SIZE,
          search: mSearch.value,
          status: mStatus.value as '' | 'confirmed' | 'pending' | 'invalid',
          shopId: Number(mShop.value) || 0,
          // 按款反查（左栏展开区撤掉后，这里是"这款认了哪些商品"的唯一入口）。
          // ⚠️ 传 0/缺省 = 不过滤；主进程 `product-db.ts` 的 `if (productId)` 就是这条判据。
          productId: mProduct.value || 0,
        }),
        api.skuSummary(),
      ]);
      mappedRows.value = list?.rows ?? [];
      mappedTotal.value = list?.total ?? 0;
      mSummary.value = sum ?? null;
      if (!mappedRows.value.length && mPage.value > 1) {
        mPage.value = Math.max(1, mPage.value - 1);
        await loadMapped();
        return;
      }
      void loadItemThumbs();
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  /**
   * 店铺商品段：快照列表 + 采集汇总 + 接收端状态，三个一起拉（状态条要同屏一致）。
   *
   * ⭐ 2026-10-16 起本段**恒为「未认款」过滤**（服务端 `onlyUnconfirmed`）：段名改叫
   * 「待关联采集商品」，已认款的采集商品只出现在「已建立映射」里（认款写的就是映射行，
   * 两个段各是一种状态的家）—— 同一个商品同时出现在两段，正是"页面不协调"的根因。
   * 原先那个「只看未认款」勾选框随之取消：默认即全部，勾选框反而让人以为"能看到已认款的"。
   *
   * 汇总**不随页过滤**：它是"每家店采了多少"的全库事实；列表才随页变。
   * 选择随每次重拉清空（与队列同一纪律）：行可能整批消失（刚认款完），留着旧键会指向不存在的行。
   */
  async function loadShopItems(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      const [list, sum] = await Promise.all([
        api.shopItemsList({ page: itemPage.value, onlyUnconfirmed: true }),
        api.shopItemsSummary(),
      ]);
      itemRows.value = list?.rows ?? [];
      itemTotal.value = list?.total ?? 0;
      itemSummary.value = sum ?? null;
      itemSelected.value = new Set();
      const r = await aeReceiverStatus();
      receiverStatus.value = r.success && r.data ? r.data : null;
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  /**
   * 只刷采集汇总（不动列表、不进 loading）—— 停在别的分段时收到「采集已入库」，
   * 先把分段徽标（`itemStats.total`）点亮；用户切进该段时 `loadShopItems` 会再拉全量。
   */
  async function loadItemSummaryOnly(): Promise<void> {
    try {
      itemSummary.value = (await api.shopItemsSummary()) ?? null;
    } catch {
      /* 徽标晚一步没大碍：切进分段时 loadShopItems 会再拉；这里弹错误反而打断当前操作 */
    }
  }

  // ---- 队列行的商品图（与映射列表**同一套**三层回落、同一份 `itemImagePool`）----
  // 队列是"还没配映射"的那一半，所以第 ③ 层（款主图）对它必然是空的 —— 有图的都是**订单图**。
  // 这正好是认款要的那张："订单里这件长什么样"。
  const queueImgs = ref(new Map<string, { dataUrl: string; localPath: string; source: string }>());
  /** 看图弹层（队列 / 映射列表共用）；null = 关着 */
  const viewer = ref<{ itemId: string; src: string; source: string } | null>(null);

  /**
   * 对比弹层**右侧**的商品图 —— 直接复用队列那份 `queueImgs`（同一张图，不重新取一次）。
   *
   * 右侧**只能**来自订单图：队列是"还没配映射"的那一半，`itemImagePool` 的第 ③ 层
   * （款主图）对它必然是空的。所以左侧（候选产品）必须**独立取图**，绝不能也去查图池 ——
   * 拿图池的"产品层"当候选图会得到一片空白，而且不报错（方案 §8-3 变异 5 钉的就是这条）。
   */
  const compareItemImage = computed(() => {
    const t = compare.value;
    if (!t) return null;
    const hit = queueImgs.value.get(t.row.itemKey);
    return hit ? { dataUrl: hit.dataUrl, source: hit.source } : null;
  });
  /** 看图请求序号：点开另一行后，先前那次原图读取的结果要丢弃（否则大图会盖到错的商品上） */
  let viewerSeq = 0;

  // ---- 映射列表的商品ID图片（三层回落：手动覆盖图 → 订单识别图 → 款主图）----
  // 主进程一次算好回落结果（`itemImagePool`），这里只挑"首选"那张并合批取缩略图。
  const itemThumbs = ref(new Map<string, string>());
  /** 有手动覆盖图的商品ID集合（显示「换图 / 清除」而不是「设图」） */
  const itemOverrides = ref(new Set<string>());
  /** 缩略图 title 里的来源说明 */
  const itemThumbSource = ref(new Map<string, string>());
  const imgBusy = ref(false);

  function pickFirst(entry: ItemImagePoolEntry | undefined): { localPath: string; source: string } | null {
    if (!entry) return null;
    if (entry.override) return { localPath: entry.override.localPath, source: '手动上传的覆盖图' };
    if (entry.order?.length) return { localPath: entry.order[0].localPath, source: '订单识别图（自动）' };
    if (entry.product) return { localPath: entry.product.localPath, source: '产品主图' };
    return null;
  }

  async function loadItemThumbs(): Promise<void> {
    const ids = [...new Set(mappedRows.value.map((r) => r.itemId).filter(Boolean))];
    const thumbs = new Map<string, string>();
    const overrides = new Set<string>();
    const sources = new Map<string, string>();
    if (ids.length) {
      try {
        const pool = (await api.itemImagePool(ids))?.pool ?? {};
        const chosen = ids
          .map((id) => ({ id, hit: pickFirst(pool[id]) }))
          .filter((x): x is { id: string; hit: { localPath: string; source: string } } => !!x.hit);
        for (const { id, hit } of chosen) sources.set(id, hit.source);
        for (const [id, entry] of Object.entries(pool)) {
          if (entry?.override) overrides.add(id);
        }
        if (chosen.length) {
          // 合批取缩略图：dataUrls 顺序与请求 items 一致，单项失败为 null（界面显示空占位）
          const r = await api.imageThumbBatch(chosen.map(({ hit }) => ({ localPath: hit.localPath })));
          (r?.dataUrls ?? []).forEach((url, i) => {
            if (url) thumbs.set(chosen[i].id, url);
          });
        }
      } catch {
        // 取图失败不挡映射列表：空占位展示
      }
    }
    itemThumbs.value = thumbs;
    itemOverrides.value = overrides;
    itemThumbSource.value = sources;
  }

  /**
   * 队列行的图：换一批 key，走的是**同一份** `itemImagePool`（三层回落）。
   *
   * ⚠️ 用 `itemKey`（归一后）而不是 `itemId`（订单原文）—— 图池的键是归一的，拿原文去查会
   * **整列空掉且不报错**，看起来像"这些订单都没图"。这两者在本页并存正是最容易被误读的地方：
   * 映射列表能用 `itemId`（`pl_shop_sku.item_id` 本来就归一存储），队列不行。
   *
   * 失败降级与映射列表一致：取不到就空占位，不挡列表、不弹错。
   */
  async function loadQueueThumbs(): Promise<void> {
    const keys = [...new Set(queueRows.value.map((r) => r.itemKey).filter(Boolean))];
    const next = new Map<string, { dataUrl: string; localPath: string; source: string }>();
    if (keys.length) {
      try {
        const pool = (await api.itemImagePool(keys))?.pool ?? {};
        const chosen = keys
          .map((k) => ({ k, hit: pickFirst(pool[k]) }))
          .filter((x): x is { k: string; hit: { localPath: string; source: string } } => !!x.hit);
        if (chosen.length) {
          // 合批取缩略图（渲染层已按 40 拆批，顺序与请求一致、单项失败为 null）
          const r = await api.imageThumbBatch(chosen.map(({ hit }) => ({ localPath: hit.localPath })));
          (r?.dataUrls ?? []).forEach((url, i) => {
            if (url) {
              next.set(chosen[i].k, {
                dataUrl: url,
                localPath: chosen[i].hit.localPath,
                source: chosen[i].hit.source,
              });
            }
          });
        }
      } catch {
        // 取图失败不挡队列：整列显示空占位
      }
    }
    queueImgs.value = next;
  }

  /* ---- 待认清单：两源合并的视图模型（2026-10-25 · P2/S1）-------------------
     右栏原先按**来源**分三段（订单队列 / 采集快照 / 已建立映射），合并后按**状态**分两段
     （待认 / 已认）。用户的心智是"还有多少没认"，不是"这些从哪来" —— 来源降为行内标签。

     ⚠️ 这里只做**呈现层的合并**：`queueRows` / `itemRows` 仍各自保留、各自的加载与写入口不变。
     一个商品不会同时出现在两源（队列减掉已生效映射；采集段恒列未认款），所以不会有重复行。
  */

  /** 采集行来源标签：`source` 值域是开放的（扩展可上报任意值），只把 `manual` 认成手贴，其余归采集 */
  function originLabelOf(source: string): string {
    return source === 'manual' ? '手贴' : '采集';
  }

  /**
   * 待认清单（订单 + 采集 → 一个形状）。
   *
   * 依赖 `queueImgs` 是有意的：图池异步加载完会重算，缩略图随之出现 ——
   * 若把图另存一份到行对象里，就变成"拉图前算过一次，之后永远没有图"。
   */
  const pendingRows = computed<PendingRow[]>(() => {
    const out: PendingRow[] = [];
    for (const r of queueRows.value) {
      // 队列行能写映射的判据是 `status === 'unmapped'`：`shopUnresolved` 的行没有平台
      // （订单里没有平台字段，平台只能从店铺实体取），拿空平台硬塞会把两家店并到一个键上。
      const blocked = r.status !== 'unmapped';
      const img = queueImgs.value.get(r.itemKey);
      out.push({
        key: `o:${queueKey(r)}`,
        origin: 'order',
        originLabel: '订单',
        itemId: r.itemId,
        shopId: r.shopId,
        shopLabel: r.shopName || r.shopRaw || '',
        platform: r.platform,
        thumb: img?.dataUrl ?? '',
        thumbKey: r.itemKey,
        autoShopHint: r.autoShopName
          ? `疑似 ${r.autoShopName}${r.autoShopPlatform ? `（${r.autoShopPlatform}）` : ''}`
          : '',
        thumbSource: img?.source ?? '',
        canRelate: !blocked,
        // 灰因只给**两个字级**的短词（2026-10-25）：它住在 96px 的操作列里，长词会折成
        // 三行（"需先登记店 / 铺 / 去登记"）。完整原因在该按钮的 title 里（悬停可见），
        // 行内紧跟着「去登记」出口 —— 短词 + 出口 + title，三件套一个不少。
        blockedReason: blocked ? '未登记' : '',
        extra: r.orderCount ? `卖出 ${r.orderCount} 笔` : '',
        skuCount: 0,
        skuText: '',
        queueRow: r,
        itemRow: null,
      });
    }
    for (const r of itemRows.value) {
      // 服务端已恒列未认款；这里再兜一层 —— 主进程口径若变，待认段也不能冒出"已认过的行"
      if (r.mappedProductId) continue;
      const blocked = !(r.shopId > 0 && !!r.platform);
      const n = itemSkuCount(r);
      out.push({
        key: `i:${r.id}`,
        origin: 'scrape',
        originLabel: originLabelOf(r.source),
        itemId: r.itemId,
        shopId: r.shopId,
        shopLabel: r.shopName || r.storeKey || '',
        platform: r.platform,
        thumb: r.imageUrl,
        thumbKey: '',
        autoShopHint: '',
        thumbSource: r.shopName || r.storeKey || '',
        canRelate: !blocked,
        blockedReason: blocked ? '未登记' : '',
        extra: n ? `SKU ${n} 条` : '',
        skuCount: n,
        skuText: itemSkuText(r),
        queueRow: null,
        itemRow: r,
      });
    }
    return out;
  });

  /** 统一的勾选集（键 = `PendingRow.key`）。两源共用一套选择 —— 动作条只报一个数 */
  const pendingSelected = ref<Set<string>>(new Set());

  /**
   * 来源筛选：`''` = 两源都看（默认），`'order'` / `'scrape'` = 只看一源。
   *
   * 为什么保留筛而不按来源分两段：分段表达的是"这些是同一件事的不同阶段"（待认 / 已认），
   * 来源是这条待办的**属性**。属性用筛选表达，阶段用分段表达 —— 否则用户要先选"从哪来"
   * 才能看到"还有多少"，等于把筛选项当成了导航。
   */
  const pendingOrigin = ref<'' | PendingOrigin>('');

  /** 当前来源筛选下要渲染的行 */
  const pendingVisible = computed(() =>
    pendingOrigin.value ? pendingRows.value.filter((r) => r.origin === pendingOrigin.value) : pendingRows.value
  );

  /**
   * 待认**总数**（权威口径）。
   *
   * ⚠️ 不能拿 `pendingRows.length` 当"还有多少没认"：那是**当前加载了几行** ——
   * 队列是分页的（`queueLimit` + 「显示更多」），行数会比真实待办少；而且它只在
   * **列表重拉**时变，停在「已认」段收到采集广播（只刷汇总）时纹丝不动，徽标就撒了谎。
   * 两侧各取自己那份统计（主进程同源）：订单 = `queuePendingTotal`（未关联 + 店铺未归一），
   * 采集 = `itemStats.unmapped`（summary 的 total - confirmed）。
   */
  const pendingOriginCount = computed(() => ({
    order: queuePendingTotal.value,
    scrape: itemStats.value.unmapped,
  }));
  /** 徽标报的数（= 两源待认之和）。含义与筛选下拉里"全部（N）"完全一致 */
  const pendingTotal = computed(() => pendingOriginCount.value.order + pendingOriginCount.value.scrape);

  /** 全选只作用于**当前可见的**可认行：筛了"订单"却把看不见的采集行也勾上，是静默扩大范围 */
  const pendingSelectable = computed(() => pendingVisible.value.filter((r) => r.canRelate));
  const pendingAllChecked = computed(
    () =>
      pendingSelectable.value.length > 0 &&
      pendingSelectable.value.every((r) => pendingSelected.value.has(r.key))
  );
  const pendingSomeChecked = computed(
    () => !pendingAllChecked.value && pendingSelectable.value.some((r) => pendingSelected.value.has(r.key))
  );
  /**
   * 勾选的行（按清单反查）。
   *
   * ⚠️ 计数一律走这里，**不要**用 `pendingSelected.size`：写入完成后队列重拉，已认的行消失，
   * 但选择集里那个 key 还在 —— 直接读 size 会显示「已选 2 项」而清单里一行都没有。
   * 从 `pendingRows` 出发过滤，计数自然跟着清单归零。
   */
  const pendingSelectedRows = computed(() =>
    pendingRows.value.filter((r) => pendingSelected.value.has(r.key) && r.canRelate)
  );
  const pendingSelectionCount = computed(() => pendingSelectedRows.value.length);

  /**
   * 动作条的**作用域说明**（2026-11-03 界面方案 §5.1 第 8 项）。
   *
   * 只说「已选 2 项」不够：用户滚到第 30 行再回来看这条吸底栏，已经不知道自己勾了哪几个，
   * 只能回去一行行找。报前 3 个商品ID，多的用「等 N 项」收口（完整名单在 title 里）。
   *
   * ⚠️ 用商品ID 而不是"第几行"：行号会随筛选/排序全变，是个假身份（本仓已踩过三次）。
   * ⚠️ 不加成按钮文案：按钮上的「认到 S2（2 项）」已经很长，再塞款名会在窄窗口挤成两行 ——
   *    款名走按钮的 title（"S2 是什么"只在看不清左栏时才需要，属低频信息）。
   */
  const pendingScopeText = computed(() => {
    // ⚠️ 必须 trim：`itemId` 是**订单原文**，可能带首尾空格（本仓已踩过这个坑：拿原文去查归一键
    //    会落空且不报错）。表格里那格显示的是同一个串、HTML 会把结尾空格吃掉 ⇒ 不 trim 的话
    //    "栏里点名的" 与 "行里的 ID" 字面不等（只差一个看不见的空格），用户对不上、断言也踩空。
    const ids = pendingSelectedRows.value
      .map((r) => (r.itemId || '').trim())
      .filter((s) => !!s);
    if (!ids.length) return '';
    const head = ids.slice(0, 3).join('、');
    return ids.length > 3 ? `${head} 等 ${ids.length} 项` : head;
  });
  const pendingScopeTitle = computed(() =>
    pendingSelectedRows.value
      .map((r) => (r.itemId || '').trim())
      .filter((s) => !!s)
      .join('、')
  );

  function togglePendingAll(e: Event): void {
    const next = new Set(pendingSelected.value);
    if ((e.target as HTMLInputElement).checked) pendingSelectable.value.forEach((r) => next.add(r.key));
    else pendingSelectable.value.forEach((r) => next.delete(r.key));
    pendingSelected.value = next;
  }

  function togglePendingOne(r: PendingRow): void {
    if (!r.canRelate) return;
    const next = new Set(pendingSelected.value);
    if (next.has(r.key)) next.delete(r.key);
    else next.add(r.key);
    pendingSelected.value = next;
  }

  function clearPendingSelection(): void {
    pendingSelected.value = new Set();
  }

  /**
   * 待认行 → 写入行：两源各走**各自的构造**（字段归属不同），拼成一个数组。
   *
   * 「认到这 N 项」（左栏直连）与弹层选款共用这一份 —— 两处各写一遍必然漂，
   * 而漂的症状是"某一条动线写进去的行少了 platform"，只在那一条动线上复发。
   */
  function pendingWriteRows(rows: PendingRow[], productId: number, color: string): SkuMapInputPayload[] {
    const queue = rows.map((r) => r.queueRow).filter((r): r is SkuQueueRow => !!r);
    const items = rows.map((r) => r.itemRow).filter((r): r is ShopItemRow => !!r);
    return [
      ...(queue.length ? queueWriteRows(queue, productId, color) : []),
      ...(items.length ? itemWriteRows(items, productId, color) : []),
    ];
  }

  /** 动作条「换一款…」：把当前勾选交给选款弹层（左栏没选款时的唯一出口） */
  function openPendingPicker(): void {
    const rows = pendingSelectedRows.value;
    if (!rows.length) return;
    picker.value = { mode: 'pending', rows };
  }

  /**
   * 「认到这 N 项」—— 待认清单**唯一**的提交动作。
   *
   * 与旧的 `relateToSelected` 的差别：那个按 `sub` 只取一个来源，而合并段里用户勾中的
   * 可能是「订单 2 条 + 采集 1 条」。这里两源拼成**一个数组**交给 `commitMap` ——
   * 仍是一次 IPC、一个事务、一套失败回传。
   *
   * `product` 可由调用方传入（动作条里刚换的款）；不传则用左栏当前款。
   */
  async function relatePending(product?: SelectedProduct | null): Promise<void> {
    const p = product ?? currentProduct.value;
    if (!p) return;
    // 认款入口收敛成一个按钮，但仍可能被连点：不挡的话第二次会发一次重复写入，
    // 数出来的行级失败会盖掉第一次的回执。
    if (busy.value) return;
    const rows = pendingSelectedRows.value;
    if (!rows.length) return;
    const payload = pendingWriteRows(rows, p.id, '');
    if (!payload.length) return;
    await commitMap(payload, '');
    clearPendingSelection();
  }

  /**
   * 点缩略图看原图。
   *
   * 先拿**缩略图**顶上（弹层立刻有东西，不让用户对着空白等 IPC），再去主进程取原图替换。
   * 原图取不到（文件被移走 / 超限）就留在缩略图上 —— 图清不清楚是次要的，不能因为取原图失败
   * 就什么都看不见。
   */
  async function openImage(r: SkuQueueRow): Promise<void> {
    const hit = queueImgs.value.get(r.itemKey);
    if (!hit) return;
    const seq = ++viewerSeq;
    viewer.value = { itemId: r.itemId, src: hit.dataUrl, source: hit.source };
    try {
      const big = await api.readImage(hit.localPath);
      if (seq !== viewerSeq) return; // 之后又点了别的行 → 这次的结果作废
      if (big?.dataUrl) viewer.value = { itemId: r.itemId, src: big.dataUrl, source: hit.source };
    } catch {
      // 保留缩略图
    }
  }

  async function pickItemThumb(itemId: string): Promise<void> {
    if (imgBusy.value) return;
    let srcPath: string | null = null;
    try {
      srcPath = await pickImage();
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), 'error');
      return;
    }
    if (!srcPath) return; // 用户取消
    imgBusy.value = true;
    try {
      await api.itemImageSet(itemId, srcPath);
      toast(`已为 ${itemId} 设置覆盖图`, 'success');
      await loadItemThumbs();
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      imgBusy.value = false;
    }
  }

  async function clearItemThumb(itemId: string): Promise<void> {
    if (imgBusy.value) return;
    imgBusy.value = true;
    try {
      await api.itemImageClear(itemId);
      toast(`已清除 ${itemId} 的覆盖图（回到自动图）`, 'success');
      await loadItemThumbs();
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      imgBusy.value = false;
    }
  }

  async function refreshAll(): Promise<void> {
    const jobs: Promise<void>[] = [loadQueue(), loadMapped()];
    // 停在采集相关分段时一起重拉：认款写完 summary 的「已认款数」会变，不拉就是旧数。
    // `pending` = 待认（订单 + 采集合并）—— 它同时显示两源，所以采集侧也必须重拉。
    if (sub.value === 'items' || sub.value === 'pending') jobs.push(loadShopItems());
    await Promise.all(jobs);
  }

  /**
   * 存量补图（2026-10-30 用户实报「认款后产品图片还是没更新」）。
   *
   * 认款顺手补图只覆盖**写入那一刻**的行；升级前已确认的映射不会自己长图。
   * 这里在打开页面时跑一轮（只补空、不覆盖、主进程单轮限量）：
   * 补上了就报一声并请外壳重拉同屏两栏；没有可补的、或网络失败都**安静**——
   * 补图是附加值，不该在打开页面时弹错误。
   */
  async function repairMissingImages(): Promise<void> {
    try {
      const r = await api.skuRepairImages({ limit: 40 });
      const adopted = Number(r?.adopted) || 0;
      if (!adopted) return;
      const left = Number(r?.pending) || 0;
      toast(
        `已为 ${adopted} 个款补上主图${left ? `，还有 ${left} 个款缺图（按「刷新」可再试）` : ''}`,
        'info'
      );
      opts.onImagesAdopted?.();
    } catch {
      // 补图失败不挡页面、不弹错（下次进页/刷新会再试）
    }
  }

  /**
   * 工具栏「刷新」：先清掉上一次的行级失败提示再重拉。
   *
   * ⚠️ 清 `failures` 的动作**不能**放进 `refreshAll()`：写入完成后是"先记失败、再重拉列表"，
   * 重拉顺手清空会把刚拿到的失败清单抹掉 —— 表现为"有行没写进去，界面却一声不响"。
   */
  function manualRefresh(): void {
    failures.value = [];
    void repairMissingImages();
    void refreshAll();
  }

  /**
   * 页级「刷新」：值变化即重拉（与工具栏「刷新」不同，**不清**失败清单 —— 那是上一次写入的回执）
   */
  watch(() => opts.refresh?.(), () => { void refreshAll(); });

  /** 「采集已入库」订阅的退订句柄（挂载时订阅、卸载时退订） */
  let offAeItems: (() => void) | null = null;

  /**
   * 空态的「去「发货台」导入订单」：**跨模块真跳转**（`switchModule`）。
   *
   * 为什么这一处是真跳转而「映射」本身不跳：队列的数据源头是订单，而导入订单只在「发货台」页 ——
   * 这一页没有它的页签，所以只能跳走。（与「总览」页点「去「货与成本」补克重」同例：
   * 主数据维护不属于发货流程的任何一步，跳转是诚实的。）
   */
  function goToday(): void {
    switchModule('today');
  }

  function gotoMapped(p: number): void {
    mPage.value = Math.min(Math.max(1, p), mappedPages.value);
    void loadMapped();
  }

  function showMore(): void {
    queueLimit.value = Math.min(QUEUE_MAX, queueLimit.value + QUEUE_STEP);
    void loadQueue();
  }

  function toggleQueueAll(e: Event): void {
    const next = new Set(selectedKeys.value);
    if ((e.target as HTMLInputElement).checked) selectableQueue.value.forEach((r) => next.add(queueKey(r)));
    else selectableQueue.value.forEach((r) => next.delete(queueKey(r)));
    selectedKeys.value = next;
  }

  function toggleQueueOne(r: SkuQueueRow): void {
    const next = new Set(selectedKeys.value);
    const k = queueKey(r);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    selectedKeys.value = next;
  }

  function clearSelection(): void {
    // 合并段的勾选是**另一套**（统一选择集）—— 只清 `selectedKeys` 会让"清空"看起来点了没用
    if (sub.value === 'pending') {
      pendingSelected.value = new Set();
      return;
    }
    if (sub.value === 'items') itemSelected.value = new Set();
    else selectedKeys.value = new Set();
  }

  /** 店铺商品段的全选 / 单选（键 = 快照行 id；商品ID 会跨店重复，不能当键） */
  function toggleItemAll(e: Event): void {
    const next = new Set(itemSelected.value);
    if ((e.target as HTMLInputElement).checked) selectableItems.value.forEach((r) => next.add(String(r.id)));
    else selectableItems.value.forEach((r) => next.delete(String(r.id)));
    itemSelected.value = next;
  }

  function toggleItemOne(r: ShopItemRow): void {
    const next = new Set(itemSelected.value);
    const k = String(r.id);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    itemSelected.value = next;
  }

  function openItemPicker(): void {
    const items = itemSelectedRows.value;
    if (!items.length) return;
    picker.value = { mode: 'items', items };
  }

  /**
   * 打开建款向导（「新建款并关联」；方案 §4.3）。
   *
   * 只接受**恰好一行**：向导预填的是**一个**商品的 SKU 矩阵，多行没有"合并预填"这回事
   * （拼起来就是猜）。入口的禁用态在 PoolPane 按 `itemSelectedRows.length === 1` 判。
   */
  function openItemWizard(r: ShopItemRow): void {
    wizardItem.value = r;
    wizardError.value = '';
    wizardReceipt.value = null;
  }

  function closeItemWizard(): void {
    wizardItem.value = null;
    wizardError.value = '';
  }

  /* ---- 删采集行（行内「删除」→ 确认弹层 → 按行 id 删）---- */

  /** 待确认删除的采集行；`null` = 确认弹层关着 */
  const pendingDeleteItem = ref<ShopItemRow | null>(null);

  function requestDeleteItem(r: ShopItemRow): void {
    pendingDeleteItem.value = r;
  }

  function cancelDeleteItem(): void {
    pendingDeleteItem.value = null;
  }

  /**
   * 确认删除。删的是**采集快照行**（`pl_shop_items`）：认款映射（`pl_shop_sku`）
   * 不受影响，重新采集这行还会按 item_id 出现并对上原映射 —— 确认弹层把这两句
   * 写给用户看。删完直接重拉（行没了 / 总数变了，状态条与列表都要同屏一致）。
   */
  async function confirmDeleteItem(): Promise<void> {
    const row = pendingDeleteItem.value;
    if (!row || busy.value) return;
    busy.value = true;
    try {
      await api.shopItemDelete(row.id);
      toast(`已删除采集行「${row.itemId}」`, 'success');
      pendingDeleteItem.value = null;
      // 勾选里可能含着被删的行（键 = 行 id）⇒ 重拉会连选择一起清，与队列同一纪律
      await loadShopItems();
    } catch (e: unknown) {
      pendingDeleteItem.value = null;
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = false;
    }
  }

  /**
   * 店铺商品的写入行 —— 与 `queueWriteRows` 同构，平台**从快照行带出**
   * （主进程 `listShopItems` JOIN `sk_shops` 给的；未登记行没有平台，
   *  根本进不了勾选态，见 `selectableItems`）。
   */
  function itemWriteRows(items: ShopItemRow[], productId: number, color: string): SkuMapInputPayload[] {
    return items.map((r) => ({
      platform: r.platform,
      shopId: r.shopId,
      itemId: r.itemId,
      spec: color || '*',
      productId,
      status: 'confirmed' as const,
    }));
  }

  /**
   * 「建档并关联」：一次点击做四件**既有**事（product-upsert → variant-upsert×N → 认款 → 图片采纳），
   * 不新增任何写口径（方案 §4.3：向导只是把既有调用按"预填→人确认"组织；P4 的图片采纳
   * 同样只走既有能力：主图=既有"只补空"规则，色图=既有款色解析 + setImageStyleColor）。
   *
   * 为什么不做"单事务回滚"（审查 P1-3）：这是多个独立 IPC、多个事务，而复合 handler 是 D3 禁的
   * ⇒ 中途失败时前面已落的撤不回来。验收改为**结构化回执 + 可重入**：
   *   · 回执说清"建了哪个款、写了几条 SKU、几条失败、关联上没有、主图/色图采纳结果"（不说"成功"这种一句话）；
   *   · 可重入 = 再点一次不会重复建款、不会撞唯一键：建档那步编码已存在会明说"换个编码"；
   *     SKU 那步先按 (color,size) 取既有行传 `id` 走**更新**路径 —— 无 id 时
   *     `variantUpsert` 撞同名直接抛（"该款下已存在相同颜色尺码的 SKU"）。
   */
  async function createProductFromItem(input: {
    code: string;
    name: string;
    category: string;
    supplierId: number;
    /** 采纳采集主图为款主图（只补空；没采到主图时向导不发这个勾选） */
    adoptImage: boolean;
    skus: { color: string; size: string; weightG: number; imageUrl: string }[];
  }): Promise<void> {
    const item = wizardItem.value;
    if (!item || wizardBusy.value) return;
    wizardBusy.value = true;
    wizardError.value = '';
    wizardReceipt.value = null;
    let variantsWritten = 0;
    let variantsFailed = 0;
    try {
      // ① 建档（编码冲突会抛：人填的号撞了必须明说，不静默改名）
      const code = input.code.trim();
      const p = await api.upsert({
        code,
        name: input.name.trim(),
        category: input.category.trim(),
        supplierId: input.supplierId,
      });
      // ② SKU 矩阵：既有行按 (color,size) 匹配传 id ⇒ 重入走更新路径，不撞唯一键
      const existing = (await api.variantList([p.id])).rows ?? [];
      for (const s of input.skus) {
        const hit = existing.find((v) => v.color === s.color && v.size === s.size);
        try {
          await api.variantUpsert({
            id: hit?.id,
            productId: p.id,
            color: s.color,
            size: s.size,
            weightG: Math.max(0, Math.round(Number(s.weightG) || 0)),
          });
          variantsWritten++;
        } catch {
          // 单行失败不中断整批（其余色码照样建）；失败数进回执
          variantsFailed++;
        }
      }
      // ③ 认到新款 —— 走**同一条**写路径（commitMap：单事务 + 行级失败回传 + 写完重拉）
      //    `adoptImages` 跟随向导里的「采纳为款主图」勾选：不勾时连"顺手补图"也要关，
      //    否则第 ③ 步已经悄悄采纳了，第 ④ 步的 `adoptMain=false` 形同虚设。
      await commitMap(itemWriteRows([item], p.id, ''), '', { adoptImages: input.adoptImage });
      // 勾选集里必须把这一行摘掉。合并段的计数是「清单 ∩ 选择集」：写完后该行离开清单，
      // 但 key 还留着 —— 动作条会继续报「已选 1 项」、「认到 X（1 项）」照样亮着，
      // 而清单里一条勾中的都没有（用户看到的是"按钮说选了，但没选"）。
      // 只摘这一行（不整集清空）：向导只允许一行进来，但别的动线可能同时勾着更多行。
      pendingSelected.value = new Set(
        [...pendingSelected.value].filter((k) => k !== `i:${item.id}`),
      );
      const related = !failures.value.some((f) => f.itemId === item.itemId);
      // ④ 图片采纳（方案 P4）：主图（勾选才采纳）+ 每色图（采到色图 URL 才采纳）。
      //    放在认款之后：色图要挂到款色上，款色按**款编码**定位，编码来自刚建档的产品行。
      //    两条都只补空、失败都**不外抛**——款与商品已经成立，坏图只在回执里说清
      //    （用户已点的"采纳主图"失败必须可见 ⇒ mainImageError 照实写进回执）。
      const colorInputs: { color: string; imageUrl: string }[] = [];
      const seenColor = new Set<string>();
      for (const s of input.skus) {
        const c = s.color.trim();
        const u = (s.imageUrl || '').trim();
        // 色→图 1:1：同色只发第一条（矩阵里同色多行时，第二条由主进程"色侧已绑"挡下）
        if (!c || !u || seenColor.has(c)) continue;
        seenColor.add(c);
        colorInputs.push({ color: c, imageUrl: u });
      }
      let mainImage: 'adopted' | 'skipped' | 'failed' = 'skipped';
      let mainImageError = '';
      const colorImages = { bound: 0, skipped: 0, failed: 0 };
      if (input.adoptImage || colorInputs.length) {
        try {
          const img = await api.shopItemImageFetch({
            id: item.id,
            productId: p.id,
            adoptMain: input.adoptImage,
            colors: colorInputs,
          });
          if (img.mainError) {
            // 没勾选采纳主图 ⇒ 它的下载失败与本次动作无关，不回执（避免"我没点它却报错"）
            if (input.adoptImage) {
              mainImage = 'failed';
              mainImageError = img.mainError;
            }
          } else if (input.adoptImage) {
            mainImage = img.adopted ? 'adopted' : 'skipped';
          }
          for (const c of img.colors || []) {
            if (c.bound) colorImages.bound++;
            else if (c.reason === 'download-failed') colorImages.failed++;
            else colorImages.skipped++;
          }
        } catch (e: unknown) {
          // 整个采纳调用失败（如采集行已被删）也不算建档失败 —— 回执里说清即可
          if (input.adoptImage) {
            mainImage = 'failed';
            mainImageError = e instanceof Error ? e.message : String(e);
          }
        }
      }
      wizardReceipt.value = {
        productId: p.id,
        productCode: code,
        variantsWritten,
        variantsFailed,
        related,
        mainImage,
        mainImageError,
        colorImages,
      };
    } catch (e: unknown) {
      wizardError.value = e instanceof Error ? e.message : String(e);
    } finally {
      wizardBusy.value = false;
    }
  }

  function openBatchPicker(): void {
    // 合并段（两栏形态）的勾选住在 `pendingSelected` 里，**不在** `selectedKeys` ——
    // 这里若照旧读 `selectedUnmapped`，弹层永远打不开（症状是"点了没反应"，静默）。
    if (sub.value === 'pending') {
      openPendingPicker();
      return;
    }
    const target = selectedUnmapped.value;
    if (!target.length) return;
    picker.value = { mode: 'queue', queue: target };
  }

  function openRowPicker(r: SkuQueueRow): void {
    picker.value = { mode: 'queue', queue: [r] };
  }

  function openRebindPicker(r: ShopSkuRow): void {
    picker.value = { mode: 'rebind', row: r };
  }

  /**
   * 队列行 → 写映射的入参行。
   * 「批量关联选中」「直连」「对比确认」**共用这一份构造** —— 三处各写一份必然漂
   * （漂的症状是"某一条动线写进去的少了 spec / 少了 status"，只在那一处复发）。
   */
  function queueWriteRows(queue: SkuQueueRow[], productId: number, color: string): SkuMapInputPayload[] {
    return queue.map((r) => ({
      platform: r.platform,
      shopId: r.shopId,
      itemId: r.itemId,
      // 颜色落在映射的 `spec` 上（D4）：空 = `'*'`（未指定），与一期行为等价
      spec: color || '*',
      productId,
      status: 'confirmed' as const,
    }));
  }

  /**
   * 一次提交一批映射 + 回执 + 重拉 —— **全页唯一**的写映射路径。
   *
   * 批量关联 / 改绑 / 直连 / 对比确认都走这里：写路径只此一条，失败语义（单事务、
   * 行级失败逐行回传、"写完必须重拉队列，已关联的组要从池里消失"）就不会有第二套。
   *
   * 不抛：失败落进 `failures` / `error`，界面怎么收尾（关不关弹层、清不清选择）交给调用方。
   */
  async function commitMap(
    rows: SkuMapInputPayload[],
    color: string,
    mapOpts?: { adoptImages?: boolean },
  ): Promise<void> {
    busy.value = true;
    failures.value = [];
    try {
      // 认款顺手补图默认开（`adoptImages` 缺省即 true）。唯一会关掉它的是「建档并关联」向导：
      // 用户取消勾选「采纳为款主图」时传 false —— 人的选择不能被"顺手"推翻。
      const res = await api.skuMap({ rows, adoptImages: mapOpts?.adoptImages !== false });
      failures.value = res?.failed ?? [];
      const created = res?.created ?? 0;
      const updated = res?.updated ?? 0;
      const reassigned = res?.reassigned ?? 0;
      const adopted = res?.adopted ?? 0;
      const failed = failures.value.length;
      // 回填报出来 —— 否则"配完映射，订单页悄悄变了"是查不出的（人不知道归款是写时触发的）；
      // 「补色」同理：给某个商品补上颜色后，它的存量订单会一起改到该色 —— 也是界面之外的变化。
      // 采纳款主图同理 —— 它写的是**产品主数据**，不说一声用户只会觉得"我的产品页怎么多了张图"。
      // 两个数都为 0 时都不提（"全零不是正确表达"），有值才报。
      const tail =
        (reassigned ? `，另有 ${reassigned} 行老订单一并归好` : '') +
        (adopted ? `，并把 ${adopted} 张商品图设为款主图` : '');
      const head = `新增 ${created} 条、更新 ${updated} 条${color ? `（颜色「${color}」）` : ''}${tail}`;
      if (failed) toast(`${head}，${failed} 条失败`, 'error');
      else toast(head, 'success');
      // 认款顺手补了款主图（写的是 `pl_products.image_id`）⇒ 通知外壳重拉左栏。
      // 右栏自己的 `refreshAll` 只管队列/快照/映射，左栏的产品列表归 `useProductList` 管：
      // 不通知它，用户会看到"回执说设了主图、左栏还是白图"（banner 与画面自相矛盾）。
      // 这是 2026-10-30「认款后产品图片还是没更新」的另一半 —— 后端写进去了，界面没重拉。
      if (adopted) opts.onImagesAdopted?.();
      await refreshAll();
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = false;
    }
  }

  /** 弹层回传选中的产品 → 组出写入行 → **一次 op** 提交整批 */
  async function applyPick(product: { id: number; color?: string }): Promise<void> {
    const target = picker.value;
    if (!target) return;
    const pickedColor = String(product.color ?? '').trim();
    let rows: SkuMapInputPayload[];
    if (target.mode === 'queue') {
      rows = queueWriteRows(target.queue, product.id, pickedColor);
    } else if (target.mode === 'items') {
      rows = itemWriteRows(target.items, product.id, pickedColor);
    } else if (target.mode === 'pending') {
      rows = pendingWriteRows(target.rows, product.id, pickedColor);
    } else {
      rows = [
        {
          platform: target.row.platform,
          shopId: target.row.shopId,
          itemId: target.row.itemId,
          // 改绑：选了新色就换，没选则**保留原色**（否则一次改绑把配好的颜色冲掉）
          spec: pickedColor || target.row.spec || '*',
          note: target.row.note,
          productId: product.id,
          // 改绑顺带把失效的映射拉回已确认 —— 用户点「改绑」就是想让它重新生效
          status: 'confirmed' as const,
        },
      ];
    }
    // 先关弹层再提交：提交失败时用户看到的是行级失败清单 / 错误条，而不是一个又弹回来的弹层
    picker.value = null;
    await commitMap(rows, pickedColor);
    // 合并段的选择集要清：写入后这些行会从待认清单消失，留着 key 只会让动作条继续报数
    if (target.mode === 'pending') clearPendingSelection();
  }

  /**
   * 「直连」：把当前分段勾选的行**一次**写到左栏当前款上（方案 §2.2 动线 B）。
   *
   * 与「批量关联选中 N 项…」的差别只在"目标产品从哪来"：那个走弹层选，这个直接用左栏
   * 展开的那一款 —— 分栏之后款与商品同屏，看一眼就知道该落到哪，不必再开弹层去搜一遍。
   *
   * ⚠️ 与弹层选产品**同一条写路径**（`commitMap`）：不新增写路径 = 不新增一套失败语义。
   * 颜色落 `'*'`（未指定）—— 直连没有选色的机会，不给色比替用户猜一个诚实：猜错会把该商品的
   * **所有**订单带到错的颜色上，而且事后看不出那是猜的。
   *
   * 店铺商品段（第三段）也走这里：勾选的是采集快照行，写入行由 `itemWriteRows` 组
   * （平台从快照行带出）—— 三个输入源、一条写路径。
   */
  async function relateToSelected(): Promise<void> {
    const p = currentProduct.value;
    if (!p) return;
    // 认款入口现在有**两处**（右栏工具栏 + 左栏展开区），后者是"发信号"式的 ——
    // 不挡一下的话，连点两次会发两次同样的写入（第二次数出来的行级失败会盖掉第一次的回执）。
    if (busy.value) return;
    if (sub.value === 'items') {
      const items = itemSelectedRows.value;
      if (!items.length) return;
      await commitMap(itemWriteRows(items, p.id, ''), '');
      return;
    }
    const target = selectedUnmapped.value;
    if (!target.length) return;
    await commitMap(queueWriteRows(target, p.id, ''), '');
  }

  /** 打开对比认款弹层（只对可关联的队列行有意义） */
  function openCompare(r: SkuQueueRow): void {
    compare.value = { row: r };
  }

  /**
   * 对比弹层里的「确认关联」（按钮或空格）。
   *
   * 候选由弹层自己翻（`←/→`），这里只收它最终停在哪一款 —— 弹层**不写库**，
   * 与 `ProductPicker` 同一分工：弹层只负责"选谁"，写映射的事务与失败上报只此一处。
   */
  async function confirmCompare(productId: number): Promise<void> {
    const t = compare.value;
    if (!t) return;
    const row = t.row;
    compare.value = null;
    await commitMap(queueWriteRows([row], productId, ''), '');
  }

  async function confirmInvalidate(): Promise<void> {
    const row = pendingInvalidate.value;
    if (!row) return;
    busy.value = true;
    failures.value = [];
    try {
      const res = await api.skuInvalidate(row.id);
      if (res?.changed) toast(`已标记「${row.itemId}」为失效`, 'success');
      else toast('这条映射已经不在了，列表已刷新', 'error');
      pendingInvalidate.value = null;
      await refreshAll();
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = false;
    }
  }

  /** 恢复：把失效的行重新标回已确认（商品ID 改回来 / 误标失效时用） */
  async function restore(r: ShopSkuRow): Promise<void> {
    busy.value = true;
    failures.value = [];
    try {
      const res = await api.skuMap({
        rows: [
          {
            platform: r.platform,
            shopId: r.shopId,
            itemId: r.itemId,
            spec: r.spec,
            note: r.note,
            productId: r.productId,
            status: 'confirmed',
          },
        ],
      });
      failures.value = res?.failed ?? [];
      if (failures.value.length) toast('恢复失败', 'error');
      else toast(`已恢复「${r.itemId}」`, 'success');
      await refreshAll();
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = false;
    }
  }

  onMounted(() => {
    void refreshAll();
    // 存量补图：把"升级前就认过、但一直没有主图"的款补上（认款写入时的那一轮覆盖不到它们）
    void repairMissingImages();
    // 扩展采集是**外部进程**写库，本页无从感知 —— 主进程落库后广播，这里据此重拉：
    // 停在采集相关分段（含合并的「待认」段）刷列表；停在别的段只刷汇总（把分段徽标先点亮）
    offAeItems = onAeItemsIngested(() => {
      if (sub.value === 'items' || sub.value === 'pending') void loadShopItems();
      else void loadItemSummaryOnly();
    });
  });
  onBeforeUnmount(() => {
    offAeItems?.();
    offAeItems = null;
  });

  return {
    // 状态
    sub,
    loading,
    busy,
    error,
    failures,
    queueRows,
    qStats,
    queueLimit,
    selectedKeys,
    mappedRows,
    mappedTotal,
    mPage,
    mSummary,
    mSearchInput,
    mStatus,
    mShop,
    mProduct,
    picker,
    pendingInvalidate,
    compare,
    viewer,
    queueImgs,
    itemThumbs,
    itemOverrides,
    itemThumbSource,
    imgBusy,
    // 店铺商品段（第三段）
    itemRows,
    itemTotal,
    itemPage,
    itemSummary,
    itemSelected,
    receiverStatus,
    itemStats,
    unresolvedItemStores,
    unresolvedShopsAll,
    unresolvedHasOrder,
    unresolvedHasItems,
    unresolvedHintTitle,
    selectableItems,
    itemSelectedRows,
    itemAllChecked,
    itemSomeChecked,
    itemSkuCount,
    itemSkuText,
    // 待认清单（两源合并 · P2/S1）：右栏两段形态只认这一套，整宽回退形态不碰
    pendingRows,
    pendingVisible,
    pendingOrigin,
    pendingOriginCount,
    pendingTotal,
    pendingSelected,
    pendingSelectable,
    pendingAllChecked,
    pendingSomeChecked,
    pendingSelectedRows,
    pendingSelectionCount,
    pendingScopeText,
    pendingScopeTitle,
    togglePendingAll,
    togglePendingOne,
    clearPendingSelection,
    openPendingPicker,
    relatePending,
    // 手贴商品ID导入（保底通道）
    manualImportOpen,
    manualImportShopId,
    manualImportText,
    manualImportBusy,
    manualImportError,
    manualImportShops,
    openManualImport,
    closeManualImport,
    submitManualImport,
    // 「打开店铺」下拉（items 段工具条）
    openShopList,
    openShopError,
    loadOpenShopList,
    openShopRows,
    openShopNow,
    // 建款向导
    wizardItem,
    wizardBusy,
    wizardError,
    wizardReceipt,
    // 删采集行（行内「删除」→ 确认弹层）
    pendingDeleteItem,
    requestDeleteItem,
    cancelDeleteItem,
    confirmDeleteItem,
    // 派生
    currentProduct,
    compareItemImage,
    unresolvedShops,
    shopOptions,
    hasQueueHints,
    selectableQueue,
    allQueueChecked,
    someQueueChecked,
    selectedUnmapped,
    mappedPages,
    mappedFiltered,
    rateText,
    queuePendingTotal,
    queueHasMore,
    pickerTitle,
    pickerConfirm,
    pickerInitialColor,
    batchLabel,
    // 方法
    queueKey,
    loadQueue,
    loadMapped,
    openImage,
    pickItemThumb,
    clearItemThumb,
    refreshAll,
    manualRefresh,
    goToday,
    gotoMapped,
    showMore,
    toggleQueueAll,
    toggleQueueOne,
    clearSelection,
    openBatchPicker,
    openRowPicker,
    openRebindPicker,
    openCompare,
    relateToSelected,
    confirmCompare,
    applyPick,
    confirmInvalidate,
    restore,
    toggleItemAll,
    toggleItemOne,
    openItemPicker,
    openItemWizard,
    closeItemWizard,
    createProductFromItem,
    loadShopItems,
  };
}

export type SkuPoolApi = ReturnType<typeof useSkuPool>;
