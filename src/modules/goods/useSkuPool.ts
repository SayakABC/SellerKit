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
//      拿空平台硬塞会把不同平台的两家店并到同一个键上。这类行只能先去店铺登记；
//   3. 批量关联**一次提交整批**（主进程单事务 + 行级失败逐行回来），不做逐条调用 ——
//      首次导入 500 行未命中是常态，逐条会把 IPC 往返变成瓶颈。

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as api from './api';
import { pickImage } from './productIo';
import { toast } from '@/core/services/toast';
import { switchModule } from '@/core/services/shell';
import type {
  ItemImagePoolEntry,
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
}

export function useSkuPool(opts: SkuPoolOptions = {}) {
  const sub = ref<'queue' | 'mapped'>('queue');
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

  const picker = ref<
    { mode: 'queue'; queue: SkuQueueRow[] } | { mode: 'rebind'; row: ShopSkuRow } | null
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
  const mappedFiltered = computed(() => !!mSearch.value || !!mStatus.value || !!mShop.value);

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

  const pickerTitle = computed(() => {
    if (picker.value?.mode !== 'queue') return '改绑到产品';
    const n = picker.value.queue.length;
    // 同 `batchLabel`：单项时不说「批量」。弹层标题比按钮多带一个数字，
    // 因为它要回答"我这就要写几行"。
    return n === 1 ? '关联 1 项到产品' : `批量关联 ${n} 项到产品`;
  });
  const pickerConfirm = computed(() =>
    picker.value?.mode === 'queue' ? `关联这 ${picker.value.queue.length} 项` : '改绑'
  );
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
  watch([mStatus, mShop], () => {
    mPage.value = 1;
    void loadMapped();
  });
  /** 切回队列视图时重拉一次：停在映射页期间别处可能改了店铺归一，表单锚点会失效 */
  watch(sub, (v) => {
    if (v === 'queue') void loadQueue();
  });

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
    await Promise.all([loadQueue(), loadMapped()]);
  }

  /**
   * 工具栏「刷新」：先清掉上一次的行级失败提示再重拉。
   *
   * ⚠️ 清 `failures` 的动作**不能**放进 `refreshAll()`：写入完成后是"先记失败、再重拉列表"，
   * 重拉顺手清空会把刚拿到的失败清单抹掉 —— 表现为"有行没写进去，界面却一声不响"。
   */
  function manualRefresh(): void {
    failures.value = [];
    void refreshAll();
  }

  /** 页级「刷新」：值变化即重拉（与工具栏「刷新」不同，**不清**失败清单 —— 那是上一次写入的回执） */
  watch(() => opts.refresh?.(), () => { void refreshAll(); });

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
    selectedKeys.value = new Set();
  }

  function openBatchPicker(): void {
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
  async function commitMap(rows: SkuMapInputPayload[], color: string): Promise<void> {
    busy.value = true;
    failures.value = [];
    try {
      const res = await api.skuMap({ rows });
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
        (adopted ? `，并把 ${adopted} 张订单图设为款主图` : '');
      const head = `新增 ${created} 条、更新 ${updated} 条${color ? `（颜色「${color}」）` : ''}${tail}`;
      if (failed) toast(`${head}，${failed} 条失败`, 'error');
      else toast(head, 'success');
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
    const rows: SkuMapInputPayload[] =
      target.mode === 'queue'
        ? queueWriteRows(target.queue, product.id, pickedColor)
        : [
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
    // 先关弹层再提交：提交失败时用户看到的是行级失败清单 / 错误条，而不是一个又弹回来的弹层
    picker.value = null;
    await commitMap(rows, pickedColor);
  }

  /**
   * 「直连」：把勾选的待关联行**一次**写到左栏当前款上（方案 §2.2 动线 B）。
   *
   * 与「批量关联选中 N 项…」的差别只在"目标产品从哪来"：那个走弹层选，这个直接用左栏
   * 展开的那一款 —— 分栏之后款与商品同屏，看一眼就知道该落到哪，不必再开弹层去搜一遍。
   *
   * ⚠️ 与弹层选产品**同一条写路径**（`commitMap`）：不新增写路径 = 不新增一套失败语义。
   * 颜色落 `'*'`（未指定）—— 直连没有选色的机会，不给色比替用户猜一个诚实：猜错会把该商品的
   * **所有**订单带到错的颜色上，而且事后看不出那是猜的。
   */
  async function relateToSelected(): Promise<void> {
    const p = currentProduct.value;
    const target = selectedUnmapped.value;
    if (!p || !target.length) return;
    // 认款入口现在有**两处**（右栏工具栏 + 左栏展开区），后者是"发信号"式的 ——
    // 不挡一下的话，连点两次会发两次同样的写入（第二次数出来的行级失败会盖掉第一次的回执）。
    if (busy.value) return;
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

  onMounted(() => void refreshAll());

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
    picker,
    pendingInvalidate,
    compare,
    viewer,
    queueImgs,
    itemThumbs,
    itemOverrides,
    itemThumbSource,
    imgBusy,
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
  };
}

export type SkuPoolApi = ReturnType<typeof useSkuPool>;
