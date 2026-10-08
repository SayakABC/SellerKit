<template>
  <!-- 两栏工作台**左栏**：产品（款式）的紧凑列表 + 行展开。
       与整宽形态（`ProductListView.vue`，`GOODS_LAYOUT='tabs'` 的回退路径）**共用同一份逻辑**
       （`../useProductList`），差别只在渲染：这里列少、把装不下的东西放进展开区。

       列的取舍（见 `docs/plans/GOODS_WORKBENCH_PLAN.md` §7-1）：
         · 主列只留「☑ / 图 / 款编码 / 款式名 / n·缺 m / 状态」—— 栏宽有限，这几列是"扫一眼找款"必需的；
         · 供应商 / 类目 / 操作（编辑、删除）**移入行展开** —— 它们是"选中之后才关心"的信息；
         · 行展开里还有 `detail-skus`（SKU 子表 + 改克重）与 `detail-links`（已关联商品，只读）。

       为什么把 SKU 改克重放进展开区、而不是像整宽形态那样放在列表下方：
       分栏之后下方那块高度被右栏占着，"点行 → 下面改"在窄栏里会把人眼睛来回拽；
       展开区紧贴那一行，改哪行看得见哪行。 -->
  <div class="gd-pane">
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
      <!-- 「问题件」：只看"有问题的那几款"。2026-10-08 页级指标条撤掉后，这里是
           「缺克重 / 未关联供应商」两个筛选的**唯一入口** —— 它不是重复控件，
           去掉等于把这两个筛选变成永远进不去的死能力。与上面两个筛选互斥（选了它自动撤供应商）。 -->
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

    <!-- 活跃筛选：只在真的筛了东西时出现（空闲时整行不存在，不占位） -->
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
        <table class="wb-table gd-pane__table" data-act="product-table">
          <thead>
            <tr>
              <th class="gd-c-exp"><span class="wb-muted" aria-hidden="true">▸</span></th>
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
              <th class="wb-num">SKU</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="p in rows" :key="p.id">
              <tr
                class="is-clickable"
                :class="{ 'is-on': p.id === expandedId }"
                :data-product-id="p.id"
                @click="toggleExpand(p.id)"
              >
                <td class="gd-c-exp">
                  <button
                    class="gd-pane__caret"
                    type="button"
                    data-act="row-expand"
                    :aria-expanded="p.id === expandedId"
                    :aria-label="`展开 ${p.code}`"
                    @click.stop="toggleExpand(p.id)"
                  >
                    {{ p.id === expandedId ? '▾' : '▸' }}
                  </button>
                </td>
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
                <td class="gd-pane__name" data-act="p-name" :title="p.name || ''">
                  {{ p.name || '—' }}
                </td>
                <!-- SKU 数与缺克重合成一格：栏宽有限，它们是同一个问题的两面（有几个 / 还差几个）。
                     两个 data-act 各自留在自己的 span 上 —— 断言钉的是"那个数字对不对"，
                     不是"它占几格"。 -->
                <td class="wb-num" :class="{ 'gd-warn': missingOf(p.id) > 0 }">
                  <span data-act="p-sku">{{ countVariants(p.id) }}</span>
                  <span class="wb-muted"> · 缺 </span>
                  <span data-act="missing-weight-cell">{{ missingOf(p.id) }}</span>
                </td>
                <td data-act="p-status">
                  <span class="wb-tag" :class="p.status === 'archived' ? '' : 'is-on'">
                    {{ p.status === 'archived' ? '停用' : '启用' }}
                  </span>
                </td>
              </tr>

              <!-- 行展开：所有"选中之后才关心"的东西都在这里。
                   ⚠️ 这一行**不带** `data-product-id` —— 它是那一行的附属信息，不是又一条产品；
                   带上的话 `[data-act="product-table"] tbody tr[data-product-id]` 会把款数算多半行。 -->
              <tr v-if="p.id === expandedId" class="gd-pane__drow" data-act="row-detail">
                <td :colspan="7">
                  <div class="gd-detail">
                    <!-- SKU 子表：改克重走与整宽形态**同一个**保存路径（全量提交，带全部现有字段） -->
                    <div class="gd-detail__block">
                      <div class="gd-detail__head">
                        <span>SKU 克重</span>
                        <span class="wb-muted" v-if="variantsOf(p.id).length">
                          {{ variantsOf(p.id).length }} 个 · 缺 {{ missingOf(p.id) }} 个
                        </span>
                      </div>
                      <table class="wb-table gd-detail__table" data-act="variant-table">
                        <thead>
                          <tr>
                            <th>SKU</th>
                            <th>编码</th>
                            <th class="wb-num gd-detail__w">克重(g)</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="v in variantsOf(p.id)" :key="v.id" :data-variant-id="v.id">
                            <td>{{ v.name }}</td>
                            <td class="wb-mono wb-muted">{{ v.code || '—' }}</td>
                            <td class="wb-num">
                              <input
                                class="wb-input wb-input--sm gd-detail__input"
                                data-act="weight"
                                type="number"
                                min="0"
                                step="1"
                                :value="v.weightG || ''"
                                :disabled="saving"
                                :aria-label="`${v.name} 克重`"
                                @click.stop
                                @change="saveWeight(v, ($event.target as HTMLInputElement).value)"
                              />
                            </td>
                          </tr>
                          <tr v-if="!variantsOf(p.id).length">
                            <td colspan="3" class="gd-detail__empty">
                              这款还没有 SKU —— 点「编辑」，用颜色 × 尺码批量生成
                            </td>
                          </tr>
                        </tbody>
                      </table>
                      <p v-if="savedHint" class="gd-detail__saved" data-act="saved">{{ savedHint }}</p>
                    </div>

                    <!-- 已关联商品：**只读反查**（数据层 `skuList({productId})`）。
                         刻意没有「解除」按钮 —— 硬删会让"关联率"莫名回落，且查不出原因；
                         失效的映射按"标失效"处理，这里只如实列出它已经不生效。 -->
                    <div class="gd-detail__block">
                      <div class="gd-detail__head">
                        <span>已关联商品</span>
                        <span class="wb-muted">
                          {{ linksBusy(p.id) ? '读取中…' : `${linksOf(p.id).length} 个店铺商品` }}
                        </span>
                      </div>
                      <ul class="gd-links" data-act="detail-links">
                        <li
                          v-for="l in linksOf(p.id)"
                          :key="l.id"
                          class="gd-links__row"
                          data-act="detail-link"
                        >
                          <span class="wb-mono">{{ l.itemId }}</span>
                          <span class="wb-muted">{{ l.shopName || `#${l.shopId}` }}</span>
                          <span class="wb-muted gd-links__plat">{{ l.platform }}</span>
                        </li>
                        <li v-if="!linksBusy(p.id) && !linksOf(p.id).length" class="wb-muted">
                          还没有店铺商品关联到这个款 —— 到右栏把商品认到这个款上，这里就会列出来
                        </li>
                      </ul>
                      <!-- 失效单列：**不能**混进上面那份"已关联"里（用户会以为那个商品还在用），
                           也不能一声不吭地藏掉（"被裁掉"和"不存在"在界面上必须长得不一样）。 -->
                      <p
                        v-if="deadLinksOf(p.id).length"
                        class="gd-links__dead"
                        data-act="detail-links-invalid"
                      >
                        另有 {{ deadLinksOf(p.id).length }} 条已失效（店铺商品ID 变了，不再计入关联）
                      </p>
                    </div>

                    <div class="gd-detail__block gd-detail__meta">
                      <p><span class="wb-muted">供应商</span> <span :class="{ 'wb-muted': !p.supplierId }" data-act="p-supplier">{{ p.supplierName || '(未关联)' }}</span></p>
                      <p><span class="wb-muted">类目</span> <span :class="{ 'wb-muted': !p.category }" data-act="p-category">{{ p.category || '—' }}</span></p>
                      <p v-if="p.note"><span class="wb-muted">备注</span> {{ p.note }}</p>
                      <p><span class="wb-muted">创建</span> {{ p.createdAt || '—' }}</p>
                    </div>

                    <div class="gd-detail__ops">
                      <button class="wb-btn wb-btn--sm" type="button" @click="openEditor(p)">
                        编辑
                      </button>
                      <button
                        class="wb-btn wb-btn--sm wb-btn--danger"
                        type="button"
                        @click="pendingDelete = { ids: [p.id], one: p }"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="!rows.length && !loading">
              <td colspan="7" class="gd-list__empty">
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
                        : '产品库是订单 / 采购 / 成本三域的关联锚点 —— 先建档，后面才有得算。'
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
// 两栏工作台左栏的渲染形态。逻辑见 `../useProductList`（与整宽形态共用）。
//
// 本组件自己只管三件**渲染专属**的事：
//   ① `expandedId` —— 哪一行展开了。**它同时是"当前款"**：展开就是选中，避免"高亮一行、
//      展开另一行"两套状态各说各话。S3 的「直连」与「对比」都落在这一款上；
//   ② `detail-links` 的取数 —— 按款反查该款关联了哪些店铺商品（`skuList({productId})`），
//      按需拉取 + 缓存（展开才拉；同一行反复展开不重复打）；
//   ③ 把"当前款"报给外壳（`select-product`）—— 跨栏通信只能经外壳，两个子组件互不认识。
import { reactive, ref, watch } from 'vue';
import { useProductList } from '../useProductList';
import * as api from '../api';
import type { ShopSkuRow, VariantRow } from '@/types';
import ProductEditorDrawer from './ProductEditorDrawer.vue';
import ProductImportDialog from './ProductImportDialog.vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';

const props = defineProps<{
  /** 页级「刷新」信号：值一变就重拉（筛选入口已搬进本栏工具栏，不再由页级下传） */
  refreshNonce: number;
}>();

/**
 * 「当前款」（`null` = 没有款被展开）。
 *
 * ⚠️ 刻意**不用** `useProductList` 里的 `selectedId`：那个会被自动设成第一行
 * （整宽形态的详情面板需要它），于是"一进页面右栏就挂着一个 `关联到 S1`" ——
 * 用户没选任何款，却有一个看起来像是自己选好的落点，照着点就是**写错款**。
 * 这里用"用户真的展开过哪一行"，语义上诚实（展开 = 我看过这款）。
 */
const emit = defineEmits<{
  'select-product': [product: { id: number; code: string; name: string } | null];
}>();

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
  thumbs,
  countVariants,
  missingOf,
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

/** 当前展开的款（同时是"当前款"—— 展开就是选中，避免"高亮一行、展开另一行"两套状态） */
const expandedId = ref(0);

function toggleExpand(id: number): void {
  if (expandedId.value === id) {
    expandedId.value = 0;
    emit('select-product', null);
    return;
  }
  expandedId.value = id;
  // 走同一个 `selectProduct`：它顺手清掉上一条保存回执（回执是"刚才那一行"的，
  // 换一行还挂着会让人以为新那行也保存过了）
  selectProduct(id);
  void loadLinks(id);
  const p = rows.value.find((x) => x.id === id);
  emit('select-product', p ? { id: p.id, code: p.code, name: p.name } : null);
}

/**
 * 刷新 / 换筛选之后，展开的那一行可能**已经不在列表里**了 —— 必须把"当前款"撤回。
 *
 * 不撤的后果不是"多显示一个按钮"，而是**写错款**：右栏那个「关联到 S1」还挂着一个
 * 屏幕上根本看不见的款，用户勾上商品点下去，映射就落到那个款上了。
 * （右栏的落点必须**始终是屏幕上看得见的那一行**，否则直连比开弹层选还危险。）
 */
watch(rows, (list) => {
  if (expandedId.value && !list.some((p) => p.id === expandedId.value)) {
    expandedId.value = 0;
    emit('select-product', null);
  }
});

const variantsOf = (id: number): VariantRow[] => variants.value[id] ?? [];

/* ---- 已关联商品（按款反查，只读） ---- */

/** productId → 该款关联的映射行；`undefined` = 还没拉过 */
const links = reactive<Record<number, ShopSkuRow[] | undefined>>({});
const linksLoading = reactive<Record<number, boolean>>({});

function linksOf(id: number): ShopSkuRow[] {
  // 只列 confirmed：失效的映射**指向的店铺商品已经不在了**，混进"已关联"会让用户
  // 以为那个商品还在用（这是 `goods:ui` 与数据层两条断言一起钉的口径）。
  return (links[id] ?? []).filter((r) => r.status === 'confirmed');
}
function deadLinksOf(id: number): ShopSkuRow[] {
  return (links[id] ?? []).filter((r) => r.status !== 'confirmed');
}
function linksBusy(id: number): boolean {
  return !!linksLoading[id];
}

async function loadLinks(productId: number): Promise<void> {
  if (links[productId] !== undefined || linksLoading[productId]) return;
  linksLoading[productId] = true;
  try {
    // 一次把该款的全部映射拿回来（含失效的），再按状态分开渲染 ——
    // 失效那几条也要能说出来（"被裁掉"和"不存在"在界面上必须长得不一样）。
    const res = await api.skuList({ productId, limit: 100 });
    links[productId] = res?.rows ?? [];
  } catch {
    // 取不到不该把展开区弄成一个错误红条：留空并允许下次再试
    links[productId] = undefined;
  } finally {
    linksLoading[productId] = false;
  }
}
</script>

<style scoped>
.gd-pane {
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
  width: 100%;
  min-width: 140px;
}
.gd-toolbar__select {
  width: auto;
  min-width: 120px;
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
  flex-wrap: wrap;
  flex-shrink: 0;
  padding: 6px 12px;
  border: 1px solid var(--wb-primary-soft);
  border-radius: var(--wb-radius-md);
  background: var(--wb-primary-soft);
  font-size: 13px;
  color: var(--wb-text);
}

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

.gd-pane__table {
  width: 100%;
}
.gd-c-exp {
  width: 30px;
}
.gd-c-check {
  width: 34px;
}
.gd-c-img {
  width: 48px;
}
/* 款式名是**弹性列**：窄栏里靠省略号，`title` 给全文（不能把名字裁掉还查不到） */
.gd-pane__name {
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gd-pane__caret {
  border: none;
  background: none;
  padding: 2px 4px;
  font: inherit;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.gd-pane__caret:hover {
  color: var(--wb-text);
}

.gd-warn {
  color: var(--wb-warning);
}

/* 展开区所在行：不随 hover 高亮（它是详情不是可点行），底色与主行区分 */
.gd-pane__drow > td {
  padding: 0;
  background: var(--wb-surface-2);
}
.gd-detail {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px 16px;
  padding: 12px;
}
@media (max-width: 1180px) {
  .gd-detail {
    grid-template-columns: minmax(0, 1fr);
  }
}
.gd-detail__block {
  min-width: 0;
}
.gd-detail__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--wb-text);
}
.gd-detail__table {
  width: 100%;
}
.gd-detail__w {
  width: 96px;
}
.gd-detail__input {
  width: 78px;
  text-align: right;
}
.gd-detail__empty {
  padding: 10px;
  text-align: center;
  white-space: normal;
  color: var(--wb-text-muted);
  font-size: 12px;
}
.gd-detail__saved {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--wb-success);
}

.gd-links {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  max-height: 160px;
  overflow: auto;
}
.gd-links__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  border-bottom: 1px dashed var(--wb-border);
}
.gd-links__plat {
  margin-left: auto;
}
.gd-links__dead {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--wb-warning);
}

.gd-detail__meta {
  font-size: 12px;
}
.gd-detail__meta p {
  margin: 0 0 4px;
  display: flex;
  gap: 8px;
}
.gd-detail__ops {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  justify-content: flex-end;
}

.gd-batch {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
