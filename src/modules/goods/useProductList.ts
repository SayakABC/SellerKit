// 「产品列表」的取数与交互逻辑 —— 由两个**渲染形态**共用：
//   · `components/ProductPane.vue`   —— 两栏工作台左栏（紧凑列表 + 行展开）
//   · `components/ProductListView.vue` —— 整宽单栏（`GOODS_LAYOUT='tabs'` 的回退形态）
//
// 为什么抽出来而不是各写一份：这里的逻辑（三个筛选互斥 / 分页 / 选择集跨页清理 /
// 全量提交的克重保存 / 缩略图合批 / 批量编辑的部分 patch / 逐条删除）约 400 行，
// 抄一份的代价不是"多 400 行"，而是**两处会漂**：回退路径没有任何冒烟覆盖，
// 抄出来的那一份错了不会有人发现，等真要回退时才发现回退不了。
// 两个组件的差别只在**模板**（列怎么排、详情放哪里），逻辑只此一处。
//
// ⚠️ 因此：改这里等于同时改两套界面。行为变更要两个形态都过一遍 `goods:ui`（跑的是
// `ProductPane`）＋ 手动切 `GOODS_LAYOUT='tabs'` 看一眼（回退形态没有冒烟）。

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import * as api from './api';
import { exportProducts, todayKey } from './productIo';
import { pickUnitCost } from '@/lib/orderCost';
import type { CostInterval } from '@/lib/orderCost';
import { toast } from '@/core/services/toast';
import type { ProductListItem, VariantRow } from '@/types';

/**
 * 「问题件」快捷筛选：一眼只看"有问题的那几款"。
 * `''` = 不筛；另两个值与「状态 / 供应商」两个筛选**互斥**（与服务端 `listProducts` 的优先级一致）。
 */
export type ProductIssueFilter = '' | 'missingWeight' | 'noSupplier';

export const PRODUCT_PAGE_SIZE = 50;

export interface ProductListOptions {
  /**
   * 页级「刷新」按钮的信号：值一变就重拉（传 getter，不要在调用方 watch）。
   *
   * 这条管线原先是"页级指标条点进来的筛选意图"（`intent`）。2026-10-08 指标条撤掉后，
   * 筛选入口搬进了本组件自己的工具栏（`issueFilter`），于是这里只剩**刷新**一个职责。
   */
  refresh?: () => number;
}

export function useProductList(opts: ProductListOptions) {
  const PAGE_SIZE = PRODUCT_PAGE_SIZE;

  const loading = ref(false);
  const busy = ref(false);
  const saving = ref(false);
  const error = ref('');
  const savedHint = ref('');

  const rows = ref<ProductListItem[]>([]);
  const total = ref(0);
  /**
   * **全库**款数（来自 `productSummary.total`）；`null` = 汇总还没拉到 —— **不是 0**。
   *
   * 与 `total` 的区别必须留着：`total` 是"当前筛选下的条数"（列表分页要用它），
   * 而"这个库到底有没有货"只能由这个不受筛选影响的数字回答。
   * 消费者：首次动线（`shouldShowFirstRunCard`，见 `./firstRun.ts`）。
   */
  const stylesTotal = ref<number | null>(null);
  const page = ref(1);
  const selectedIds = ref<Set<number>>(new Set());

  const supplierOptions = ref<{ id: number; name: string; productCount: number }[]>([]);

  const searchInput = ref('');
  const searchApplied = ref('');
  const statusFilter = ref('');
  const supplierFilter = ref('');
  /**
   * 「问题件」是**单一真源**，下面两个布尔由它**派生**。
   *
   * 为什么不保留两个可各自为真的 `ref`：入口已从"指标条上点一下"换成工具栏里的**一个下拉**，
   * 而下拉只能有一个值 —— 两个独立 ref 会出现"下拉显示『缺克重』、实际两个条件都在生效"
   * 这种界面对不上、且看不出哪里错的状态（服务端又是快捷筛选优先，第三个条件等于被静默丢弃）。
   */
  const issueFilter = ref<ProductIssueFilter>('');
  const onlyMissingWeight = computed(() => issueFilter.value === 'missingWeight');
  const withoutSupplier = computed(() => issueFilter.value === 'noSupplier');

  const editorOpen = ref(false);
  const editing = ref<ProductListItem | null>(null);
  const importOpen = ref(false);
  const pendingDelete = ref<{ ids: number[]; one: ProductListItem | null } | null>(null);

  /** 产品 id → 该款的 SKU（本页一次性合批取回，行展开与速修面板共用同一份） */
  const variants = ref<Record<number, VariantRow[]>>({});
  /**
   * 款编码 → **当前生效进价**（分）；`null` = 还没价。列表「进价」列读它。
   * 口径与算钱 / 拣货一致（`pickUnitCost` 按今天取；见 `loadCosts`）。
   */
  const costCentsByCode = ref(new Map<string, number | null>());
  const selectedId = ref(0);

  const selected = computed(() => rows.value.find((p) => p.id === selectedId.value) ?? null);
  const variantsOfSelected = computed(() => variants.value[selectedId.value] ?? []);
  const countVariants = (id: number): number => (variants.value[id] ?? []).length;
  const missingOf = (id: number): number =>
    (variants.value[id] ?? []).filter((v) => !(Number(v.weightG) > 0)).length;

  /** 该款当前生效进价（分）；`null` = 还没价（查不到也当没价，与库层一致） */
  const costCentsOf = (code: string): number | null => costCentsByCode.value.get(code) ?? null;

  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
  const filtered = computed(
    () =>
      !!searchApplied.value ||
      !!statusFilter.value ||
      !!supplierFilter.value ||
      onlyMissingWeight.value ||
      withoutSupplier.value
  );
  const allChecked = computed(
    () => rows.value.length > 0 && rows.value.every((p) => selectedIds.value.has(p.id))
  );
  const someChecked = computed(
    () => !allChecked.value && rows.value.some((p) => selectedIds.value.has(p.id))
  );

  /* ---- 加载 ---- */

  async function load(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      // 三个筛选开关互斥（与服务端 `listProducts` 的优先级一致），否则用户会得到
      // "看起来筛了两项、其实只生效一项"的困惑
      const res = await api.list({
        offset: (page.value - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        search: searchApplied.value,
        status: statusFilter.value as '' | 'active' | 'archived',
        supplierId:
          onlyMissingWeight.value || withoutSupplier.value ? 0 : Number(supplierFilter.value) || 0,
        onlyMissingWeight: onlyMissingWeight.value,
        withoutSupplier: withoutSupplier.value,
      });
      rows.value = res?.rows ?? [];
      total.value = res?.total ?? 0;

      // 当前页被删空时回退一页，避免停在空白页
      if (!rows.value.length && page.value > 1) {
        page.value = Math.max(1, page.value - 1);
        await load();
        return;
      }
      // 选中项已不在本页 → 移出选择集（跨页保留会让"删除选中"删掉看不见的行）
      for (const id of [...selectedIds.value]) {
        if (!rows.value.some((p) => p.id === id)) selectedIds.value.delete(id);
      }
      // 选中款不在本页时清掉，让详情回到空态而不是显示上一页的款
      if (selectedId.value && !rows.value.some((p) => p.id === selectedId.value)) {
        selectedId.value = 0;
        savedHint.value = '';
      }

      await loadVariants();
      await loadCosts();
      void loadThumbs();
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  async function loadVariants(): Promise<void> {
    const ids = rows.value.map((p) => p.id);
    const map: Record<number, VariantRow[]> = {};
    if (ids.length) {
      const vs = await api.variantList(ids);
      for (const v of vs?.rows ?? []) (map[v.productId] ??= []).push(v);
    }
    variants.value = map;
    if (!selectedId.value && rows.value.length) selectedId.value = rows.value[0].id;
  }

  /**
   * 拉**本页**每款的「当前生效进价」（分）。
   *
   * 口径与算钱 / 拣货两页一致：一次读全 `ae_cost_map`，用 `pickUnitCost` 按**今天**取该款
   * 当时生效的那条（同一天 manual 优先）。列表只要这一页的款 —— 导出那条路是全量补价
   * （`productIo.fillExportCosts`），两处共用同一份取价实现。
   *
   * 读不到成本（ae 库还没建等）**不挡列表**：进价列显示「—」，其余照常。
   */
  async function loadCosts(): Promise<void> {
    const codes = rows.value.map((p) => p.code).filter(Boolean);
    const map = new Map<string, number | null>();
    if (!codes.length) {
      costCentsByCode.value = map;
      return;
    }
    try {
      const list = await api.costMapList();
      const costs: CostInterval[] = list.map((x) => ({
        styleCode: String(x.styleCode ?? ''),
        effectiveFrom: String(x.effectiveFrom ?? ''),
        unitPrice: (Number(x.unitPriceCents) || 0) / 100,
        source: String(x.source ?? ''),
      }));
      const today = todayKey();
      for (const code of codes) {
        const unit = pickUnitCost(costs, code, today);
        map.set(code, unit === null ? null : Math.round(unit * 100));
      }
    } catch {
      // 读不到 → 全部 null（列显示「—」），不挡列表
    }
    costCentsByCode.value = map;
  }

  async function loadSupplierOptions(): Promise<void> {
    try {
      const s = await api.summary();
      supplierOptions.value = s?.supplierOptions ?? [];
      // 全库款数（首次动线要用它判"零款"）。
      // ⚠️ 刻意取 `summary.total` 而不是列表的 `total`：后者是**按当前筛选**算的 ——
      //    用户开着"缺克重"筛选时它可以是 0，于是"零款"会被一个筛选条件伪造出来，
      //    首启引导卡就会在**有货**的库里冒出来。
      stylesTotal.value = typeof s?.total === 'number' ? s.total : null;
    } catch {
      // 供应商下拉拿不到不该挡住列表：只是筛选项少一个
      supplierOptions.value = [];
      // ⚠️ 拉不到就是**不知道**，必须回落 `null` 而不是留 0：留 0 会被读成"这个库是空的"。
      stylesTotal.value = null;
    }
  }

  async function loadSummaryCounts(): Promise<void> {
    await loadSupplierOptions();
  }

  /** 主图缩略图（合批：一页 50 行一次调用；单项失败置 null，界面显示空占位） */
  const thumbs = ref(new Map<number, string>());

  async function loadThumbs(): Promise<void> {
    const items = rows.value.filter((p) => p.imagePath).map((p) => ({ key: p.id, path: p.imagePath }));
    const next = new Map<number, string>();
    if (items.length) {
      try {
        const r = await api.imageThumbBatch(items.map((it) => ({ localPath: it.path })));
        (r?.dataUrls ?? []).forEach((url, i) => {
          if (url) next.set(items[i].key, url);
        });
      } catch {
        // 缩略图失败不挡列表：占位展示
      }
    }
    thumbs.value = next;
  }

  /** 改动后：重拉列表 + 汇总。
   *  ⚠️ 这里原先还 `opts.onChanged?.()` 上报外壳去重算页级指标 —— 指标条撤掉后那个回调
   *  零消费者，整条链（含两个组件的 `changed` emit）已删除，不再留"转发了没人听"的空管道。 */
  async function refreshAll(): Promise<void> {
    await Promise.all([load(), loadSummaryCounts()]);
  }

  /* ---- 筛选 ---- */

  /** 搜索防抖：每次按键都发一次 IPC 会让长列表明显卡顿 */
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  watch(searchInput, (v) => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchApplied.value = v.trim();
      page.value = 1;
      void load();
    }, 300);
  });
  onBeforeUnmount(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });

  /**
   * 改状态 / 供应商筛选时：**先把快捷筛选撤掉**。
   * 服务端三个筛选是互斥的（`listProducts` 里快捷筛选优先，供应商条件会被忽略），
   * 原先靠"禁用供应商下拉 + 静默清空快捷筛选"处理 —— 用户看不出自己刚选的那项为什么不生效。
   * 现在反过来：**选了供应商就自动撤掉快捷筛选**，被撤掉的那项会从活跃筛选行里消失，
   * 用户看得见发生了什么（选择本身就是意图，不该被静默丢弃）。
   */
  watch([statusFilter, supplierFilter], () => {
    if (supplierFilter.value && issueFilter.value) issueFilter.value = '';
    page.value = 1;
    void load();
  });

  /**
   * 选了「问题件」→ 撤掉供应商条件（快捷筛选优先）。
   * 两个方向都撤一次，才不会留下"看着筛了两项、其实只生效一项"的困惑。
   * 注：这个 watcher 里若改了 `supplierFilter`，上面那个会再跑一次 —— 多一次 IPC，
   *     但只在"供应商 ↔ 问题件"互切时发生，换来的是两处状态永远不可能各自为真。
   */
  watch(issueFilter, (v) => {
    if (v && supplierFilter.value) supplierFilter.value = '';
    page.value = 1;
    void load();
  });

  function clearFilters(): void {
    searchInput.value = '';
    searchApplied.value = '';
    statusFilter.value = '';
    supplierFilter.value = '';
    issueFilter.value = '';
    page.value = 1;
    void load();
  }

  /** 活跃筛选 chip 上显示供应商名（不能只显示 id） */
  const supplierLabel = computed(() => {
    const s = supplierOptions.value.find((o) => String(o.id) === supplierFilter.value);
    return s?.name || `#${supplierFilter.value}`;
  });

  /**
   * 撤掉**单个**筛选条件（活跃筛选 chip 上的 ×）。
   * 用 key 分派而不是每个 chip 写一个函数：以后加筛选条件时只改这一处，不会漏。
   */
  function clearOne(key: 'search' | 'status' | 'supplier' | 'missingWeight' | 'noSupplier'): void {
    if (key === 'search') {
      searchInput.value = '';
      searchApplied.value = '';
    } else if (key === 'status') {
      statusFilter.value = '';
    } else if (key === 'supplier') {
      supplierFilter.value = '';
    } else {
      // 两个「只看…」chip 指向同一个下拉，撤任一项都等于把下拉拨回"全部款式"
      issueFilter.value = '';
    }
    page.value = 1;
    void load();
  }

  /** 页级「刷新」按钮：值变化即重拉（走 refreshAll，与"改完数据后重拉"同一条路径） */
  watch(() => opts.refresh?.(), () => { void refreshAll(); });

  /* ---- 选择 ---- */

  /** 选中某款（清掉上一条保存回执 —— 回执是"刚才那一行的"，换行就不该继续挂着） */
  function selectProduct(id: number): void {
    selectedId.value = id;
    savedHint.value = '';
  }

  function toggleAll(e: Event): void {
    const next = new Set(selectedIds.value);
    const checked = (e.target as HTMLInputElement).checked;
    if (checked) rows.value.forEach((p) => next.add(p.id));
    else rows.value.forEach((p) => next.delete(p.id));
    selectedIds.value = next;
  }

  function toggleOne(id: number): void {
    const next = new Set(selectedIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds.value = next;
  }

  function clearSelection(): void {
    selectedIds.value = new Set();
  }

  function goto(p: number): void {
    page.value = Math.min(Math.max(1, p), totalPages.value);
    void load();
  }

  /* ---- 编辑 ---- */

  function openEditor(product: ProductListItem | null): void {
    editing.value = product;
    editorOpen.value = true;
  }

  function onEditorSaved(_result: unknown, opts2?: { keepOpen?: boolean }): void {
    // 主图 / SKU 在抽屉内是**即时保存**（emit 带 keepOpen），不能把抽屉关掉
    if (opts2?.keepOpen) {
      void refreshAll();
      return;
    }
    editorOpen.value = false;
    void refreshAll();
  }

  function onImported(): void {
    importOpen.value = false;
    page.value = 1;
    void refreshAll();
  }

  /* ---- 补克重 ---- */

  /**
   * 改克重：**带上该行全部现有字段**。
   * `productVariantUpsert` 是全量提交 —— 只传 `weightG` 会把颜色/尺码/名称静默清空，
   * 界面却显示"保存成功"（这是 `goods:ui` 冒烟专门盯的一条）。
   */
  async function saveWeight(v: VariantRow, raw: string): Promise<void> {
    const g = Math.max(0, Math.round(Number(raw) || 0));
    if (g === Number(v.weightG)) return;
    saving.value = true;
    error.value = '';
    try {
      await api.variantUpsert({
        id: v.id,
        productId: v.productId,
        code: v.code,
        name: v.name,
        color: v.color,
        size: v.size,
        weightG: g,
        status: v.status as 'active' | 'archived',
      });
      v.weightG = g;
      savedHint.value = `已保存：${v.name} → ${g || 0} g`;
      toast(`已保存 ${v.name} → ${g || 0} g`, 'success');
    } catch (e: unknown) {
      error.value = `保存失败：${e instanceof Error ? e.message : '未知错误'}`;
      toast(error.value, 'error');
    } finally {
      saving.value = false;
    }
  }

  /* ---- 批量编辑 ---- */

  const batchEditOpen = ref(false);
  const batchBusy = ref(false);
  const batchError = ref('');
  const batch = reactive({ supplierId: '', category: '', status: '', note: '' });

  function openBatchEdit(): void {
    batch.supplierId = '';
    batch.category = '';
    batch.status = '';
    batch.note = '';
    batchError.value = '';
    batchEditOpen.value = true;
  }

  async function applyBatchEdit(): Promise<void> {
    if (batchBusy.value) return;
    const patch: {
      supplierId?: number;
      category?: string;
      status?: 'active' | 'archived';
      note?: string;
    } = {};
    if (batch.supplierId !== '') patch.supplierId = Number(batch.supplierId) || 0;
    if (batch.category.trim() !== '') patch.category = batch.category.trim();
    if (batch.status !== '') patch.status = batch.status as 'active' | 'archived';
    if (batch.note.trim() !== '') patch.note = batch.note.trim();

    if (!Object.keys(patch).length) {
      batchError.value = '所有字段都留空 —— 至少修改一项';
      return;
    }
    batchBusy.value = true;
    batchError.value = '';
    try {
      const r = await api.batchUpdate({ ids: [...selectedIds.value], ...patch });
      batchEditOpen.value = false;
      selectedIds.value = new Set();
      toast(`已更新 ${r?.updated ?? 0} 个产品`, 'success');
      await refreshAll();
    } catch (e: unknown) {
      batchError.value = e instanceof Error ? e.message : String(e);
    } finally {
      batchBusy.value = false;
    }
  }

  /* ---- 删除 ---- */

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete.value;
    if (!target) return;
    busy.value = true;
    let done = 0;
    let failed = 0;
    // 逐条删除：主进程没有批量删除通道，且逐条能让失败精确定位到是哪一条
    for (const id of target.ids) {
      try {
        const r = await api.remove(id);
        if (r?.deleted) done += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    busy.value = false;
    pendingDelete.value = null;
    selectedIds.value = new Set();
    if (failed) toast(`已删除 ${done} 条，${failed} 条失败`, 'error');
    else toast(`已删除 ${done} 条`, 'success');
    await refreshAll();
  }

  /* ---- 导入 / 导出 ---- */

  async function downloadTemplate(): Promise<void> {
    busy.value = true;
    try {
      const r = await exportProducts({ template: true });
      toast(`模板已保存：${r?.filePath || ''}`, 'success');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/cancel/i.test(msg)) toast(`下载模板失败：${msg}`, 'error');
    } finally {
      busy.value = false;
    }
  }

  async function doExport(): Promise<void> {
    busy.value = true;
    try {
      // 导出**当前筛选下的全部行**（不只这一页）—— 筛选条件一并带给导出
      const r = await exportProducts({
        search: searchApplied.value,
        status: (onlyMissingWeight.value || withoutSupplier.value
          ? ''
          : statusFilter.value) as '' | 'active' | 'archived',
        supplierId: Number(supplierFilter.value) || 0,
      });
      toast(`已导出：${r?.filePath || ''}`, 'success');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/cancel/i.test(msg)) toast(`导出失败：${msg}`, 'error');
    } finally {
      busy.value = false;
    }
  }

  onMounted(() => {
    void loadSummaryCounts();
    void load();
  });

  return {
    // 状态
    loading,
    busy,
    saving,
    error,
    savedHint,
    rows,
    total,
    stylesTotal,
    page,
    selectedIds,
    supplierOptions,
    searchInput,
    searchApplied,
    statusFilter,
    supplierFilter,
    issueFilter,
    onlyMissingWeight,
    withoutSupplier,
    editorOpen,
    editing,
    importOpen,
    pendingDelete,
    variants,
    selectedId,
    thumbs,
    // 派生
    selected,
    variantsOfSelected,
    countVariants,
    missingOf,
    costCentsOf,
    totalPages,
    filtered,
    allChecked,
    someChecked,
    supplierLabel,
    // 方法
    load,
    refreshAll,
    clearFilters,
    clearOne,
    selectProduct,
    toggleAll,
    toggleOne,
    clearSelection,
    goto,
    openEditor,
    onEditorSaved,
    onImported,
    saveWeight,
    openBatchEdit,
    applyBatchEdit,
    confirmDelete,
    downloadTemplate,
    doExport,
    // 批量编辑弹层的本地状态
    batchEditOpen,
    batchBusy,
    batchError,
    batch,
  };
}

export type ProductListApi = ReturnType<typeof useProductList>;
