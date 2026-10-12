<template>
  <div class="gd-product">
    <!-- 工具栏：筛选在左，动作在右。**常驻只留每次都用得到的**：
         搜索 / 状态 / 供应商三个筛选，导出 / 导入 / 新增三个动作。
         「下载模板」挪走了 —— 它是"没有现成表格时"才需要的，已经在导入弹层里，且那里文案更贴场景
         （"没有现成表格？下载导入模板"），常驻在工具栏只是多一个要读的按钮。
         「问题件」是一个**下拉**（不是两个常驻开关）：下拉天然只有一个值，不会再出现
         "点了一个、另一个被静默关掉"的问题；2026-10-08 顶部指标条撤掉后，它也是
         「缺克重 / 未关联供应商」两个筛选的唯一入口。 -->
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
      <select
        v-model="issueFilter"
        class="wb-input gd-toolbar__select"
        data-act="filter-issue"
        aria-label="问题件筛选"
      >
        <option value="">全部款式</option>
        <option value="missingWeight">缺克重</option>
        <option value="noSupplier">未关联供应商</option>
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
              <th class="wb-num">进价</th>
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
              <td class="wb-num" data-act="p-cost">
                <span
                  v-if="costText(p.code) === '—'"
                  class="wb-muted"
                  title="还没维护进价（导入模板填「进价」列，或从拿货对账同步）"
                  >—</span
                >
                <span v-else>{{ costText(p.code) }}</span>
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
              <td colspan="11" class="gd-list__empty">
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
// 逻辑全部来自 `../useProductList`（与工作台左栏 `ProductPane` 共用一份）——
// 这里只保留**整宽表格**这一种渲染形态，以及它自带的「选中行 → 下方速修面板」动线。
// 为什么把逻辑抽走：两个形态若各抄一份，回退路径（本组件）没有冒烟覆盖，抄错的那一份
// 不会有人发现 —— 等真要回退时才发现回退不了。
import { useProductList } from '../useProductList';
import SkuWeightPanel from './SkuWeightPanel.vue';
import ProductEditorDrawer from './ProductEditorDrawer.vue';
import ProductImportDialog from './ProductImportDialog.vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';

const props = defineProps<{
  /** 页级「刷新」信号：值一变就重拉（筛选入口在本组件自己的工具栏里） */
  refreshNonce: number;
}>();

// ⚠️ 这里原先还有 `changed` / `suppliers-changed` 两个 emit（把子视图的变动报给外壳去重算
//    页级指标条 + 页签徽标）。2026-10-08 指标条与徽标一起撤掉后，那一层零消费者 → 整条删除。

const {
  loading,
  busy,
  saving,
  error,
  savedHint,
  rows,
  total,
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
  batchEditOpen,
  batchBusy,
  batchError,
  batch,
} = useProductList({ refresh: () => props.refreshNonce });

/** 进价（元，两位小数）；还没价显示「—」（**不写 0.00** —— 0 会被读成"零成本/免费"） */
function costText(code: string): string {
  const cents = costCentsOf(code);
  return cents === null ? '—' : (cents / 100).toFixed(2);
}
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
