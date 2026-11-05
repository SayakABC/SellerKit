<template>
  <div class="gd-shop">
    <div class="gd-toolbar">
      <input
        v-model="searchInput"
        class="wb-input gd-toolbar__search"
        type="search"
        placeholder="搜索商品ID / 店铺…"
        aria-label="搜索商品"
      />
      <span v-if="loading" class="wb-muted gd-toolbar__hint">读取中…</span>
      <div class="gd-toolbar__actions">
        <button class="wb-btn" type="button" data-act="shop-refresh" :disabled="busy || loading" @click="manualRefresh">
          刷新
        </button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="shop-import"
          :disabled="busy"
          @click="importFromExcel"
        >
          {{ busy ? '导入中…' : '导入商品' }}
        </button>
      </div>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error">{{ error }}</p>
    <p v-if="importResult" class="wb-notice wb-notice--ok" data-act="shop-import-result">
      导入完成：新增 {{ importResult.imported }} 条，更新 {{ importResult.updated }} 条。
    </p>

    <section class="wb-panel gd-panel">
      <div class="wb-panel__head">
        <span>商品清单</span>
        <span class="wb-muted">共 {{ total }} 条</span>
      </div>

      <div class="wb-panel__body">
        <table class="wb-table" data-act="shop-product-table">
          <thead>
            <tr>
              <th class="gd-c-img">图</th>
              <th>商品ID</th>
              <th>店铺</th>
              <th>关联产品</th>
              <th>导入时间</th>
              <th class="gd-c-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in rows" :key="item.itemId" :data-item-id="item.itemId">
              <td class="gd-c-img">
                <img
                  v-if="thumbOf(item)"
                  :src="thumbOf(item)"
                  class="wb-thumb"
                  alt=""
                  @error="markBroken(item.itemId)"
                />
                <span v-else class="wb-thumb wb-thumb--empty" title="暂无图片（未填链接或外链已失效）"></span>
              </td>
              <td class="wb-mono" data-act="sp-id">{{ item.itemId }}</td>
              <td :class="{ 'wb-muted': !item.shopName }" data-act="sp-shop">{{ item.shopName || '—' }}</td>
              <td data-act="sp-relations">
                <span v-if="item.relationCount > 0" class="wb-tag is-on">
                  {{ item.relationCount }} 个产品
                </span>
                <span v-else class="wb-tag is-warn">未关联</span>
              </td>
              <td class="wb-muted gd-nowrap" data-act="sp-imported">{{ formatTime(item.importedAt) }}</td>
              <td class="gd-c-ops">
                <button class="wb-link" type="button" data-act="sp-manage" :disabled="busy" @click="openRelations(item)">
                  管理关联…
                </button>
                <button
                  class="wb-link wb-link--danger"
                  type="button"
                  data-act="sp-delete"
                  :disabled="busy"
                  @click="pendingDelete = item"
                >
                  删除
                </button>
              </td>
            </tr>
            <tr v-if="!rows.length && !loading">
              <td colspan="6" class="gd-panel__empty">
                <div class="wb-empty">
                  <div class="wb-empty__icon" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                      <rect x="3" y="4" width="18" height="16" rx="2" />
                      <path d="M3 10h18M9 4v16" />
                    </svg>
                  </div>
                  <p class="wb-empty__title">{{ hasFilter ? '没有符合条件的商品' : '还没有商品' }}</p>
                  <p class="wb-empty__desc">
                    {{
                      hasFilter
                        ? '换个关键字，或清空搜索框再试。'
                        : '商品清单是「店铺 × 商品ID」的原始池子：从 Excel 导入后，在这里把一件商品关联到一个或多个产品。与「映射与关联」的区别是——那边是订单里自动聚出来的待确认队列，这边是你手工导入的清单。'
                    }}
                  </p>
                  <div class="wb-empty__actions">
                    <button v-if="hasFilter" class="wb-btn" type="button" @click="clearSearch">
                      清空搜索
                    </button>
                    <button v-else class="wb-btn wb-btn--primary" type="button" @click="importFromExcel">
                      导入商品
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="pages > 1" class="wb-panel__foot wb-pager">
        <span>共 {{ total }} 条，第 {{ page }} / {{ pages }} 页</span>
        <span class="wb-pager__spacer"></span>
        <button class="wb-btn wb-btn--sm" type="button" :disabled="page <= 1 || loading" @click="gotoPage(page - 1)">
          上一页
        </button>
        <button
          class="wb-btn wb-btn--sm"
          type="button"
          :disabled="page >= pages || loading"
          @click="gotoPage(page + 1)"
        >
          下一页
        </button>
      </div>
    </section>

    <!-- 关联管理：一件商品 → 多个产品（套装场景）。改动的只是本商品的关联集合。 -->
    <div v-if="relationManager" class="wb-mask" @click.self="closeRelations">
      <div class="wb-dialog wb-dialog--md" role="dialog" aria-modal="true">
        <div class="wb-dialog__head">
          管理关联 · <span class="wb-mono">{{ relationManager.item.itemId }}</span>
          <span v-if="relationManager.relations.length" class="wb-muted">
            （{{ relationManager.relations.length }} 个产品）
          </span>
        </div>
        <div class="wb-dialog__body sp-body">
          <p v-if="relationManager.loading" class="wb-muted">加载中…</p>
          <p v-else-if="!relationManager.relations.length" class="wb-muted sp-empty">
            这件商品还没有关联任何产品 —— 点右下角「添加关联」从产品库里挑。
          </p>
          <ul v-else class="sp-relations">
            <li v-for="rel in relationManager.relations" :key="rel.id" :data-relation-id="rel.id">
              <span class="wb-mono sp-code">{{ rel.productCode }}</span>
              <span class="sp-name">{{ rel.productName || '—' }}</span>
              <button
                class="wb-link wb-link--danger"
                type="button"
                :disabled="busy"
                @click="deleteRelation(rel.id)"
              >
                移除
              </button>
            </li>
          </ul>
        </div>
        <div class="wb-dialog__foot">
          <button class="wb-btn" type="button" @click="closeRelations">关闭</button>
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            data-act="sp-add-relation"
            :disabled="busy || relationManager.loading"
            @click="pickerOpen = true"
          >
            添加关联…
          </button>
        </div>
      </div>
    </div>

    <!-- 选产品放在关联弹层**之后**：两层都是 `.wb-mask`（同 z-index），
         靠 DOM 顺序决定压在上面，写在前面会被关联弹层盖住。 -->
    <ProductPicker
      v-if="pickerOpen"
      title="选择要关联的产品"
      confirm-text="添加关联"
      @close="pickerOpen = false"
      @pick="addRelation"
    />

    <ConfirmDialog
      v-if="pendingDelete"
      title="删除商品"
      confirm-text="确认删除"
      busy-text="删除中…"
      :busy="busy"
      @close="pendingDelete = null"
      @confirm="doDelete"
    >
      <p>
        将删除商品 <b class="wb-mono">{{ pendingDelete.itemId }}</b>。
      </p>
      <p v-if="pendingDelete.relationCount > 0" class="wb-notice wb-notice--warn">
        该商品已关联 {{ pendingDelete.relationCount }} 个产品，删除后这些关联关系一并消失，且无法恢复。
      </p>
      <p class="wb-field__hint">
        只影响本页这份手工清单，不碰订单识别出的「映射与关联」。
      </p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
// 「商品清单」页签：从 Excel 导入商品（按 item_id 去重），手工关联产品库里的产品（一对多）。
//
// 与「映射与关联」页的区别（两个页签都在这一页下，别混）：
//   · 商品清单：**手工导入**的商品池，支持一对多关联（套装场景）；
//   · 映射与关联：从**订单自动聚合**出来的商品ID，一对一映射（订单归款用）。
//
// 数据流：
//   1. 导入商品：Excel → 取「产品ID / 产品图片链接」两列 → 按 item_id 去重 → 落池子
//   2. 添加关联：选产品 → 一个 item_id 可以有多条关联
//   3. 删除商品：按 item_id 删掉该商品的全部记录
//
// 迁移时改掉的三处（岛 → 宿主）：
//   ① 选产品从**原生 `<select>`（一次塞 500 个 option）**换成搜索式选择器 ——
//      千级选项的下拉既难找又卡，而"搜索 + 单选"复用产品页同一套查询。
//   ② 图片能真的显示了：岛跑在 `sk-plugin://` 下，CSP 是 `img-src 'self' data:`，
//      外链图一律被拦（表现为"导入的图全是空占位"）；内建渲染层没有这条限制。
//   ③ 顶部"已关联 N / 未关联 N"两个数字**删掉**：原实现是按**当前页**算的，
//      却摆在全局位置，用户会当成全库统计（分页场景下这种假数字比没有更糟）。
//      改为逐行标签，是就是/不是就是不是。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as api from '../api';
import { readShopProductFile, pickExcel } from '../productIo';
import { toast } from '@/core/services/toast';
import ProductPicker from './ProductPicker.vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import type { ShopProductItem, ShopProductRelation } from '@/types';

const emit = defineEmits<{ changed: [] }>();

const PAGE_SIZE = 50;

const loading = ref(false);
const busy = ref(false);
const error = ref('');
const importResult = ref<{ imported: number; updated: number } | null>(null);

const rows = ref<ShopProductItem[]>([]);
const total = ref(0);
const page = ref(1);
const searchInput = ref('');
const search = ref('');

/** 已加载失败的图片 URL（按 itemId 记）—— 避免 `@error` 后仍反复重试同一条坏链 */
const broken = ref(new Set<string>());

const relationManager = ref<{
  item: ShopProductItem;
  relations: ShopProductRelation[];
  loading: boolean;
} | null>(null);
const pickerOpen = ref(false);
const pendingDelete = ref<ShopProductItem | null>(null);

const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const hasFilter = computed(() => !!search.value);

function thumbOf(item: ShopProductItem): string {
  if (!item.imageUrl || broken.value.has(item.itemId)) return '';
  return item.imageUrl;
}

function markBroken(itemId: string): void {
  const next = new Set(broken.value);
  next.add(itemId);
  broken.value = next;
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(searchInput, (v) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    search.value = v.trim();
    page.value = 1;
    void loadList();
  }, 300);
});
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});

async function loadList(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const res = await api.shopProductList({
      offset: (page.value - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
      search: search.value,
    });
    rows.value = res?.rows ?? [];
    total.value = res?.total ?? 0;
    // 当前页被删空 → 回退一页，别停在空白页
    if (!rows.value.length && page.value > 1) {
      page.value = Math.max(1, page.value - 1);
      await loadList();
      return;
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function gotoPage(p: number): void {
  page.value = Math.min(Math.max(1, p), pages.value);
  void loadList();
}

function clearSearch(): void {
  searchInput.value = '';
  search.value = '';
  page.value = 1;
  void loadList();
}

function manualRefresh(): void {
  importResult.value = null;
  void loadList();
}

function formatTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 导入商品。
 * **没有预览环节**是刻意的：商品清单是原始池子，未关联的商品本来就该进来排队等人工确认 ——
 * 拦下来只会让人以为"导入失败"。（产品导入则必须先预览，因为那会写主数据。）
 */
async function importFromExcel(): Promise<void> {
  error.value = '';
  importResult.value = null;
  let file: Awaited<ReturnType<typeof pickExcel>> = null;
  try {
    file = await pickExcel();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  if (!file) return; // 用户取消

  busy.value = true;
  try {
    const items = await readShopProductFile(file);
    if (!items.length) {
      error.value = 'Excel 里没有读到有效的「产品ID」列（列名需为「产品ID」）。';
      return;
    }
    const res = await api.shopProductImport({ items });
    importResult.value = { imported: res?.imported ?? 0, updated: res?.updated ?? 0 };
    toast(`导入完成：新增 ${res?.imported ?? 0} 条，更新 ${res?.updated ?? 0} 条`, 'success');
    await loadList();
    emit('changed');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = msg;
    toast(`导入失败：${msg}`, 'error');
  } finally {
    busy.value = false;
  }
}

async function openRelations(item: ShopProductItem): Promise<void> {
  relationManager.value = { item, relations: [], loading: true };
  try {
    relationManager.value.relations = await api.shopProductRelations(item.itemId);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
    toast(`加载关联失败：${e instanceof Error ? e.message : e}`, 'error');
  } finally {
    if (relationManager.value) relationManager.value.loading = false;
  }
}

function closeRelations(): void {
  relationManager.value = null;
  pickerOpen.value = false;
}

async function addRelation(product: { id: number }): Promise<void> {
  const target = relationManager.value;
  if (!target) return;
  busy.value = true;
  try {
    await api.shopProductRelationAdd({ itemId: target.item.itemId, productId: product.id });
    toast('关联已添加', 'success');
    pickerOpen.value = false;
    target.relations = await api.shopProductRelations(target.item.itemId);
    await loadList();
    emit('changed');
  } catch (e: unknown) {
    toast(`添加关联失败：${e instanceof Error ? e.message : e}`, 'error');
  } finally {
    busy.value = false;
  }
}

async function deleteRelation(relId: number): Promise<void> {
  const target = relationManager.value;
  if (!target) return;
  busy.value = true;
  try {
    await api.shopProductRelationDelete(relId);
    toast('关联已移除', 'success');
    target.relations = await api.shopProductRelations(target.item.itemId);
    await loadList();
    emit('changed');
  } catch (e: unknown) {
    toast(`移除关联失败：${e instanceof Error ? e.message : e}`, 'error');
  } finally {
    busy.value = false;
  }
}

async function doDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (!target) return;
  busy.value = true;
  try {
    const res = await api.shopProductDelete(target.itemId);
    toast(`已删除 ${res?.removed ?? 0} 条记录`, 'success');
    pendingDelete.value = null;
    await loadList();
    emit('changed');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    toast(`删除失败：${msg}`, 'error');
    error.value = msg;
    pendingDelete.value = null;
  } finally {
    busy.value = false;
  }
}

onMounted(() => void loadList());
</script>

<style scoped>
.gd-shop {
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
.gd-toolbar__hint {
  font-size: 12px;
}
.gd-toolbar__actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.gd-panel {
  flex: 1;
  min-height: 180px;
}
.gd-panel__empty {
  padding: 0;
}
.gd-c-img {
  width: 52px;
}
.gd-c-ops {
  width: 130px;
  white-space: nowrap;
}
.gd-nowrap {
  white-space: nowrap;
}

.sp-body {
  min-height: 120px;
}
.sp-empty {
  margin: 0;
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
}
.sp-relations {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.sp-relations li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}
.sp-code {
  flex-shrink: 0;
  width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sp-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--wb-text-muted);
}
</style>
