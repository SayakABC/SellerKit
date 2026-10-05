<template>
  <div class="gd-product">
    <!-- 工具栏：筛选在左，动作在右。**常驻只留每次都用得到的**：
         搜索 / 状态 / 供应商三个筛选，导出 / 导入 / 新增三个动作。
         「下载模板」挪走了 —— 它是"没有现成表格时"才需要的，已经在导入弹层里，且那里文案更贴场景
         （"没有现成表格？下载导入模板"），常驻在工具栏只是多一个要读的按钮。
         两个「只看…」开关也撤了 —— 它们与顶部指标条重复，且互相**静默**关闭、看不出互斥；
         现在的筛选结果由下面那行「活跃筛选」显示，入口统一在顶部指标条。 -->
    <div class="gd-toolbar">
      <input
        v-model="searchInput"
        class="wb-input gd-toolbar__search"
        type="search"
        placeholder="搜索款编码 / 款式名 / 类目…"
        aria-label="搜索产品"
      />
      <select v-model="statusFilter" class="wb-input gd-toolbar__select" aria-label="状态筛选">
        <option value="">全部状态</option>
        <option value="active">启用</option>
        <option value="archived">停用</option>
      </select>
      <select
        v-model="supplierFilter"
        class="wb-input gd-toolbar__select"
        data-act="filter-supplier"
        aria-label="供应商筛选"
      >
        <option value="">全部供应商</option>
        <option v-for="s in supplierOptions" :key="s.id" :value="String(s.id)">
          {{ s.name || `#${s.id}` }}（{{ s.productCount }}）
        </option>
      </select>

      <span v-if="loading" class="wb-muted gd-toolbar__hint">读取中…</span>

      <div class="gd-toolbar__actions">
        <button class="wb-btn" type="button" :disabled="busy" @click="doExport">导出</button>
        <button class="wb-btn" type="button" :disabled="busy" @click="importOpen = true">
          导入 Excel
        </button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="new-product"
          :disabled="busy"
          @click="openEditor(null)"
        >
          新增产品
        </button>
      </div>
    </div>

    <!-- 活跃筛选：**只在真的筛了东西时出现**（空闲时这一行完全不存在，不占位）。
         每个 chip 都能一键撤掉，另有「清空全部」。
         取代原来两个常驻开关的理由：常驻开关看不出"哪些条件正在生效"，也看不出
         其中一个点下去会**静默**关掉另一个（服务端三个筛选是互斥的）。 -->
    <div v-if="filtered" class="gd-filters" data-act="active-filters">
      <span class="gd-filters__label">筛选</span>
      <button
        v-if="searchApplied"
        class="gd-chip"
        type="button"
        data-act="chip-search"
        @click="clearOne('search')"
      >
        搜索「{{ searchApplied }}」<span aria-hidden="true">×</span>
      </button>
      <button
        v-if="statusFilter"
        class="gd-chip"
        type="button"
        data-act="chip-status"
        @click="clearOne('status')"
      >
        状态：{{ statusFilter === 'archived' ? '停用' : '启用' }}<span aria-hidden="true">×</span>
      </button>
      <button
        v-if="supplierFilter"
        class="gd-chip"
        type="button"
        data-act="chip-supplier"
        @click="clearOne('supplier')"
      >
        供应商：{{ supplierLabel }}<span aria-hidden="true">×</span>
      </button>
      <button
        v-if="onlyMissingWeight"
        class="gd-chip gd-chip--warn"
        type="button"
        data-act="chip-missing"
        @click="clearOne('missingWeight')"
      >
        只看缺克重<span aria-hidden="true">×</span>
      </button>
      <button
        v-if="withoutSupplier"
        class="gd-chip gd-chip--warn"
        type="button"
        data-act="chip-no-supplier"
        @click="clearOne('noSupplier')"
      >
        只看未关联供应商<span aria-hidden="true">×</span>
      </button>
      <button
        class="wb-btn wb-btn--sm wb-btn--ghost"
        type="button"
        data-act="clear-filters"
        @click="clearFilters"
      >
        清空全部
      </button>
    </div>

    <!-- 选中态：动作条只在有选择时出现（常驻会占一行且大多数时候是灰的） -->
    <div v-if="selectedIds.size" class="gd-selbar" data-act="selection-bar">
      <span>已选 <b>{{ selectedIds.size }}</b> 个款</span>
      <button class="wb-btn wb-btn--sm" type="button" :disabled="busy" @click="openBatchEdit">
        批量编辑
      </button>
      <button
        class="wb-btn wb-btn--sm wb-btn--danger"
        type="button"
        :disabled="busy"
        @click="pendingDelete = { ids: [...selectedIds], one: null }"
      >
        删除选中
      </button>
      <button class="wb-btn wb-btn--sm wb-btn--ghost" type="button" @click="clearSelection">
        清空选择
      </button>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error">{{ error }}</p>

    <section class="wb-panel gd-list">
      <div class="wb-panel__head">
        <span>产品</span>
        <span class="wb-muted">{{ total }}</span>
        <span v-if="filtered" class="wb-muted">· 已筛选</span>
      </div>

      <div class="wb-panel__body">
        <table class="wb-table" data-act="product-table">
          <thead>
            <tr>
              <th class="gd-c-check">
                <input
                  type="checkbox"
                  :checked="allChecked"
                  :indeterminate.prop="someChecked"
                  aria-label="全选本页"
                  @change="toggleAll"
                />
              </th>
              <th class="gd-c-img">图</th>
              <th>款编码</th>
              <th>款式名</th>
              <th>供应商</th>
              <th>类目</th>
              <th class="wb-num">SKU</th>
              <th class="wb-num">缺克重</th>
              <th>状态</th>
              <th class="gd-c-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in rows"
              :key="p.id"
              class="is-clickable"
              :class="{ 'is-on': p.id === selectedId }"
              :data-product-id="p.id"
              @click="selectProduct(p.id)"
            >
              <td class="gd-c-check" @click.stop>
                <input
                  type="checkbox"
                  :checked="selectedIds.has(p.id)"
                  :aria-label="`选择 ${p.code}`"
                  @change="toggleOne(p.id)"
                />
              </td>
              <td class="gd-c-img">
                <img v-if="thumbs.get(p.id)" :src="thumbs.get(p.id)" class="wb-thumb" alt="" />
                <span v-else class="wb-thumb wb-thumb--empty" title="暂无主图"></span>
              </td>
              <td class="wb-mono" data-act="p-code">{{ p.code }}</td>
              <td data-act="p-name">{{ p.name || '—' }}</td>
              <td :class="{ 'wb-muted': !p.supplierId }" data-act="p-supplier">
                {{ p.supplierName || '(未关联)' }}
              </td>
              <td :class="{ 'wb-muted': !p.category }" data-act="p-category">
                {{ p.category || '—' }}
              </td>
              <td class="wb-num" data-act="p-sku">{{ countVariants(p.id) }}</td>
              <!-- 0 就写 0：旧写法 `missingOf(p.id) || '—'` 把"这款不缺"渲染成「—」，
                   用户读成"数据缺/没生效"（2026-10-01 实报：补完 SKU 克重后看到「—」以为没保存）。 -->
              <td
                class="wb-num"
                data-act="missing-weight-cell"
                :class="{ 'gd-warn': missingOf(p.id) > 0 }"
              >
                {{ missingOf(p.id) }}
              </td>
              <td data-act="p-status">
                <span class="wb-tag" :class="p.status === 'archived' ? '' : 'is-on'">
                  {{ p.status === 'archived' ? '停用' : '启用' }}
                </span>
              </td>
              <td class="gd-c-ops">
                <button class="wb-link" type="button" @click.stop="openEditor(p)">编辑</button>
                <button
                  class="wb-link wb-link--danger"
                  type="button"
                  @click.stop="pendingDelete = { ids: [p.id], one: p }"
                >
                  删除
                </button>
              </td>
            </tr>
            <tr v-if="!rows.length && !loading">
              <td colspan="10" class="gd-list__empty">
                <div class="wb-empty">
                  <div class="wb-empty__icon" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                      <path d="M21 8l-9-5-9 5 9 5 9-5z" />
                      <path d="M3 8v8l9 5 9-5V8" />
                    </svg>
                  </div>
                  <p class="wb-empty__title">{{ filtered ? '没有符合条件的款' : '还没有产品' }}</p>
                  <p class="wb-empty__desc">
                    {{
                      filtered
                        ? '换个关键字，或把上面的筛选条件清掉再试。'
                        : '产品库是订单 / 采购 / 成本三域的关联锚点 —— 先建档，后面才有得算。可以用「下载模板」填好后导入，也可以手工新增。'
                    }}
                  </p>
                  <div class="wb-empty__actions">
                    <button v-if="filtered" class="wb-btn" type="button" @click="clearFilters">
                      清空筛选
                    </button>
                    <template v-else>
                      <button class="wb-btn" type="button" @click="importOpen = true">
                        导入 Excel
                      </button>
                      <button class="wb-btn wb-btn--primary" type="button" @click="openEditor(null)">
                        新增产品
                      </button>
                    </template>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="totalPages > 1" class="wb-panel__foot gd-list__foot">
        <span class="wb-muted">共 {{ total }} 条，第 {{ page }} / {{ totalPages }} 页</span>
        <span class="wb-pager__spacer"></span>
        <button class="wb-btn wb-btn--sm" type="button" :disabled="page <= 1 || loading" @click="goto(page - 1)">
          上一页
        </button>
        <button
          class="wb-btn wb-btn--sm"
          type="button"
          :disabled="page >= totalPages || loading"
          @click="goto(page + 1)"
        >
          下一页
        </button>
      </div>
    </section>

    <!-- 补克重速修：常驻在列表下方，选款即改（见组件头注释解释为何不做成抽屉） -->
    <SkuWeightPanel
      :product="selected"
      :variants="variantsOfSelected"
      :saving="saving"
      :saved-hint="savedHint"
      @save="saveWeight"
    />

    <!-- 完整编辑（抽屉：改的时候列表还看得见，方便对照） -->
    <ProductEditorDrawer
      v-if="editorOpen"
      :product="editing"
      :suppliers="supplierOptions"
      @close="editorOpen = false"
      @saved="onEditorSaved"
    />

    <ProductImportDialog
      v-if="importOpen"
      @close="importOpen = false"
      @done="onImported"
      @template="downloadTemplate"
    />

    <!-- 批量编辑（部分 patch：留空 = 不修改） -->
    <div v-if="batchEditOpen" class="wb-mask" @click.self="batchEditOpen = false">
      <div class="wb-dialog wb-dialog--sm" role="dialog" aria-modal="true">
        <div class="wb-dialog__head">批量编辑 {{ selectedIds.size }} 个款</div>
        <div class="wb-dialog__body gd-batch">
          <label class="wb-field">
            <span class="wb-field__label">供应商</span>
            <select v-model="batch.supplierId" class="wb-input">
              <option value="">不修改</option>
              <option value="0">未关联（清空供应商）</option>
              <option v-for="s in supplierOptions" :key="s.id" :value="String(s.id)">
                {{ s.name || `#${s.id}` }}
              </option>
            </select>
          </label>
          <label class="wb-field">
            <span class="wb-field__label">类目</span>
            <input v-model="batch.category" class="wb-input" placeholder="留空 = 不修改" />
          </label>
          <label class="wb-field">
            <span class="wb-field__label">状态</span>
            <select v-model="batch.status" class="wb-input">
              <option value="">不修改</option>
              <option value="active">启用</option>
              <option value="archived">停用</option>
            </select>
          </label>
          <label class="wb-field">
            <span class="wb-field__label">备注（整列覆盖）</span>
            <input
              v-model="batch.note"
              class="wb-input"
              placeholder="留空 = 不修改；填写则覆盖所有选中行"
            />
          </label>
          <p v-if="batchError" class="wb-notice wb-notice--error">{{ batchError }}</p>
          <p class="wb-field__hint">
            款编码与款式名不可批量修改 —— 编码是跨域关联的锚点，改名会让历史数据指向别处。
          </p>
        </div>
        <div class="wb-dialog__foot">
          <button class="wb-btn" type="button" :disabled="batchBusy" @click="batchEditOpen = false">
            取消
          </button>
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            :disabled="batchBusy"
            @click="applyBatchEdit"
          >
            {{ batchBusy ? '保存中…' : '应用到选中行' }}
          </button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-if="pendingDelete"
      title="确认删除"
      confirm-text="确认删除"
      busy-text="删除中…"
      :busy="busy"
      @close="pendingDelete = null"
      @confirm="confirmDelete"
    >
      <p v-if="pendingDelete.one">
        将删除产品
        <b class="wb-mono">{{ pendingDelete.one.code }}</b>
        {{ pendingDelete.one.name ? `（${pendingDelete.one.name}）` : '' }}。
      </p>
      <p v-else>将删除选中的 <b>{{ pendingDelete.ids.length }}</b> 个产品。</p>
      <p class="wb-notice wb-notice--warn">
        删除是物理删除且不可撤销。已进入订单 / 采购 / 成本链路的款请改用「停用」——
        编码是跨域关联的锚点，删掉会让历史数据指向空。
      </p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
// 「产品」页签：产品（款式）主数据 —— 检索 / 新增编辑 / 批量编辑 / 批量删除 / Excel 导入导出
// ＋ 补克重速修。
//
// 这一页合并了原本分居两处的两半：
//   · 内建「货与成本」—— 只读 + 改克重（算钱视角）
//   · UI 岛「产品库」—— 完整主数据维护（建档视角）
// 合并后不再有"这功能在岛里、那功能在宿主里"的分裂，也没有了"岛要单独发版"的同步成本。
//
// 布局取舍：产品表**全宽**（10 列），补克重面板放在**下方常驻**而不是右侧 ——
// 右侧栏会把表格压到 500px 以下，10 列挤成一团；而"点行 → 下面改克重"的操作动线并不比左右并排慢。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import * as api from '../api';
import { exportProducts } from '../productIo';
import { toast } from '@/core/services/toast';
import type { ProductListItem, VariantRow } from '@/types';
import SkuWeightPanel from './SkuWeightPanel.vue';
import ProductEditorDrawer from './ProductEditorDrawer.vue';
import ProductImportDialog from './ProductImportDialog.vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';

const props = defineProps<{
  /** 来自页级指标条的筛选意图（`nonce` 保证连点两次也能生效） */
  intent: { key: 'all' | 'missingWeight' | 'noSupplier'; nonce: number };
}>();

const emit = defineEmits<{ changed: []; 'suppliers-changed': [] }>();

const PAGE_SIZE = 50;

const loading = ref(false);
const busy = ref(false);
const saving = ref(false);
const error = ref('');
const savedHint = ref('');

const rows = ref<ProductListItem[]>([]);
const total = ref(0);
const page = ref(1);
const selectedIds = ref<Set<number>>(new Set());

const supplierOptions = ref<{ id: number; name: string; productCount: number }[]>([]);

const searchInput = ref('');
const searchApplied = ref('');
const statusFilter = ref('');
const supplierFilter = ref('');
const onlyMissingWeight = ref(false);
const withoutSupplier = ref(false);

const editorOpen = ref(false);
const editing = ref<ProductListItem | null>(null);
const importOpen = ref(false);
const pendingDelete = ref<{ ids: number[]; one: ProductListItem | null } | null>(null);

/** 产品 id → 该款的 SKU */
const variants = ref<Record<number, VariantRow[]>>({});
const selectedId = ref(0);

const selected = computed(() => rows.value.find((p) => p.id === selectedId.value) ?? null);
const variantsOfSelected = computed(() => variants.value[selectedId.value] ?? []);
const countVariants = (id: number): number => (variants.value[id] ?? []).length;
const missingOf = (id: number): number =>
  (variants.value[id] ?? []).filter((v) => !(Number(v.weightG) > 0)).length;

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
      supplierId: onlyMissingWeight.value || withoutSupplier.value ? 0 : Number(supplierFilter.value) || 0,
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
    // 选中款不在本页时清掉，让速修面板回到空态而不是显示上一页的款
    if (selectedId.value && !rows.value.some((p) => p.id === selectedId.value)) {
      selectedId.value = 0;
      savedHint.value = '';
    }

    await loadVariants();
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

async function loadSupplierOptions(): Promise<void> {
  try {
    const s = await api.summary();
    supplierOptions.value = s?.supplierOptions ?? [];
  } catch {
    // 供应商下拉拿不到不该挡住列表：只是筛选项少一个
    supplierOptions.value = [];
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

/** 改动后：重拉列表 + 汇总 + 通知外壳刷新页级指标 */
async function refreshAll(): Promise<void> {
  await Promise.all([load(), loadSummaryCounts()]);
  emit('changed');
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
  if (supplierFilter.value) {
    onlyMissingWeight.value = false;
    withoutSupplier.value = false;
  }
  page.value = 1;
  void load();
});

function clearFilters(): void {
  searchInput.value = '';
  searchApplied.value = '';
  statusFilter.value = '';
  supplierFilter.value = '';
  onlyMissingWeight.value = false;
  withoutSupplier.value = false;
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
  } else if (key === 'missingWeight') {
    onlyMissingWeight.value = false;
  } else {
    withoutSupplier.value = false;
  }
  page.value = 1;
  void load();
}

/** 页级指标条点进来的筛选意图（与手动改筛选走同一套状态，不另开一条路径） */
function applyIntent(key: 'all' | 'missingWeight' | 'noSupplier'): void {
  if (key === 'all') {
    clearFilters();
    return;
  }
  onlyMissingWeight.value = key === 'missingWeight';
  withoutSupplier.value = key === 'noSupplier';
  supplierFilter.value = '';
  page.value = 1;
  void load();
}

watch(
  () => props.intent,
  (v) => applyIntent(v.key)
);

/* ---- 选择 ---- */

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

function onEditorSaved(_result: unknown, opts?: { keepOpen?: boolean }): void {
  // 主图 / SKU 在抽屉内是**即时保存**（emit 带 keepOpen），不能把抽屉关掉
  if (opts?.keepOpen) {
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
    emit('changed');
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
</script>

<style scoped>
.gd-product {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gd-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.gd-toolbar__search {
  width: 260px;
}
.gd-toolbar__select {
  width: auto;
  min-width: 130px;
}
.gd-toolbar__hint {
  font-size: 12px;
}
.gd-toolbar__actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.gd-selbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 6px 12px;
  border: 1px solid var(--wb-primary-soft);
  border-radius: var(--wb-radius-md);
  background: var(--wb-primary-soft);
  font-size: 13px;
  color: var(--wb-text);
}

/* 活跃筛选行：空闲时**整行不存在**（v-if），所以它不占垂直空间、也不增加"要看的东西" */
.gd-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.gd-filters__label {
  font-size: 12px;
  color: var(--wb-text-muted);
}

/* 可移除的筛选 chip。比 .wb-tag 多一个 ×，所以自带一份样式、不做成基座变体 ——
   全仓目前只有这一处用。 */
.gd-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  font-family: inherit;
  font-size: 12px;
  color: var(--wb-text);
  cursor: pointer;
}
.gd-chip:hover {
  border-color: var(--wb-border-strong);
  background: var(--wb-hover);
}
.gd-chip--warn {
  border-color: var(--wb-warning-soft);
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}

.gd-list {
  flex: 1;
  min-height: 180px;
}
.gd-list__foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.gd-list__empty {
  padding: 0;
}

.gd-c-check {
  width: 34px;
}
.gd-c-img {
  width: 52px;
}
.gd-c-ops {
  width: 100px;
  white-space: nowrap;
}

.gd-warn {
  color: var(--wb-warning);
}

.gd-batch {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
