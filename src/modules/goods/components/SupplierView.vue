<template>
  <div class="gd-supplier">
    <div class="gd-toolbar">
      <span class="gd-toolbar__hint">
        自「订单归类 → 拿货对账」迁移而来；拿货单 / 付款 / 欠款对账仍在订单归类。这里是款式关联供应商的
        唯一入口。
      </span>
      <div class="gd-toolbar__actions">
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="new-supplier"
          :disabled="busy"
          @click="openEditor(null)"
        >
          新增供应商
        </button>
      </div>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error">{{ error }}</p>

    <section class="wb-panel gd-panel">
      <div class="wb-panel__head">
        <span>供应商</span>
        <span class="wb-muted">{{ rows.length }}</span>
        <span class="wb-muted">· 已关联产品 {{ linkedProductCount }}</span>
      </div>

      <div class="wb-panel__body">
        <table class="wb-table" data-act="supplier-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>电话</th>
              <th>备注</th>
              <th class="wb-num">产品数</th>
              <th>创建时间</th>
              <th class="gd-c-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in rows" :key="s.id" :data-supplier-id="s.id">
              <td class="wb-mono" data-act="s-name">{{ s.name }}</td>
              <td :class="{ 'wb-muted': !s.phone }" data-act="s-phone">{{ s.phone || '—' }}</td>
              <td :class="{ 'wb-muted': !s.note }" data-act="s-note">{{ s.note || '—' }}</td>
              <td class="wb-num" data-act="s-count">{{ productCountOf(s.id) }}</td>
              <td class="wb-muted gd-nowrap" data-act="s-created">{{ s.createdAt }}</td>
              <td class="gd-c-ops">
                <button class="wb-link" type="button" data-act="s-edit" @click="openEditor(s)">
                  编辑
                </button>
                <button
                  class="wb-link wb-link--danger"
                  type="button"
                  data-act="s-delete"
                  @click="pendingDelete = s"
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
                      <path d="M3 21h18M5 21V7l7-4 7 4v14" />
                      <path d="M9 21v-6h6v6" />
                    </svg>
                  </div>
                  <p class="wb-empty__title">还没有供应商</p>
                  <p class="wb-empty__desc">
                    新增后可在「产品」页给款式关联供应商 —— 供应商是算成本、生成拿货单时的分组依据。
                  </p>
                  <div class="wb-empty__actions">
                    <button class="wb-btn wb-btn--primary" type="button" @click="openEditor(null)">
                      新增供应商
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 新增 / 编辑：编辑时名称锁定（名称是 UNIQUE 键，拿货单与产品都按它展示） -->
    <div v-if="editorOpen" class="wb-mask" @click.self="closeEditor">
      <div class="wb-dialog wb-dialog--sm" role="dialog" aria-modal="true">
        <div class="wb-dialog__head">
          {{ editing ? `编辑供应商 · ${editing.name}` : '新增供应商' }}
        </div>
        <div class="wb-dialog__body sup-form">
          <label v-if="!editing" class="wb-field">
            <span class="wb-field__label">名称 <i class="wb-field__req">*</i></span>
            <input
              v-model="form.name"
              class="wb-input"
              data-act="sup-name"
              placeholder="如：广州某某服装厂"
            />
          </label>
          <p v-else class="wb-field__hint">
            名称是唯一键，拿货单与产品都按它展示，因此不在这里改名。
          </p>
          <label class="wb-field">
            <span class="wb-field__label">电话</span>
            <input v-model="form.phone" class="wb-input" data-act="sup-phone" placeholder="选填" />
          </label>
          <label class="wb-field">
            <span class="wb-field__label">备注</span>
            <input v-model="form.note" class="wb-input" data-act="sup-note" placeholder="选填" />
          </label>
          <p v-if="formError" class="wb-notice wb-notice--error">{{ formError }}</p>
        </div>
        <div class="wb-dialog__foot">
          <button class="wb-btn" type="button" :disabled="busy" @click="closeEditor">取消</button>
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            data-act="sup-save"
            :disabled="busy || (!editing && !form.name.trim())"
            @click="save"
          >
            {{ busy ? '保存中…' : '保存' }}
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
      <p>
        将删除供应商 <b class="wb-mono">{{ pendingDelete.name }}</b>。
      </p>
      <p v-if="productCountOf(pendingDelete.id) > 0" class="wb-notice wb-notice--warn">
        该供应商名下还有 {{ productCountOf(pendingDelete.id) }} 个产品，删除后这些产品会变成「未关联供应商」。
      </p>
      <p class="wb-field__hint">已有拿货单或付款记录的供应商无法删除（主进程守卫，保护对账历史）。</p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
// 「供应商」（供应商）页签。
//
// 语义来自 2026-09-27 的迁移：管理入口（新增/编辑/删除）收拢到产品域，
// 拿货单 / 付款 / 欠款对账等**业务视图**仍留在订单归类 —— 数据同源（`suppliers` 表）。
// 两条不能动的规则：
//   · 编辑只放开电话 / 备注：名称是 UNIQUE 键，改它会让历史拿货单指向别处；
//   · 删除有拿货单 / 付款记录时由主进程拒绝，错误原样展示（**不能只弹 toast 一闪而过**，
//     用户要照着提示去处理）。
import { computed, onMounted, reactive, ref } from 'vue';
import * as api from '../api';
import { toast } from '@/core/services/toast';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import type { Supplier } from '@/types';

const emit = defineEmits<{ changed: [] }>();

const loading = ref(false);
const busy = ref(false);
const error = ref('');
const rows = ref<Supplier[]>([]);
const /** id → 该供应商名下的产品数（来自 `product.summary`，不在这页自己数） */
  productCountMap = ref(new Map<number, number>());

const editorOpen = ref(false);
const editing = ref<Supplier | null>(null);
const form = reactive({ name: '', phone: '', note: '' });
const formError = ref('');
const pendingDelete = ref<Supplier | null>(null);

const linkedProductCount = computed(() =>
  [...productCountMap.value.values()].reduce((a, b) => a + b, 0)
);

function productCountOf(id: number): number {
  return productCountMap.value.get(id) ?? 0;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [list, sum] = await Promise.all([api.supplierList(), api.summary()]);
    // ⚠️ 形状不对时**报错**而不是 `?? []`：后者会把"读错了对象"伪装成"没有数据"，
    //    界面显示空列表，用户以为供应商被删光了。
    if (!Array.isArray(list)) {
      throw new Error(`供应商列表返回了意外的形状（${typeof list}）—— 请检查主进程的 purchase-supplier-list`);
    }
    rows.value = list;
    productCountMap.value = new Map((sum?.supplierOptions ?? []).map((x) => [x.id, x.productCount]));
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function openEditor(s: Supplier | null): void {
  editing.value = s;
  form.name = s?.name ?? '';
  form.phone = s?.phone ?? '';
  form.note = s?.note ?? '';
  formError.value = '';
  editorOpen.value = true;
}

function closeEditor(): void {
  if (busy.value) return;
  editorOpen.value = false;
}

async function save(): Promise<void> {
  if (busy.value) return;
  formError.value = '';
  busy.value = true;
  try {
    if (editing.value) {
      await api.supplierUpdate({
        id: editing.value.id,
        phone: form.phone.trim(),
        note: form.note.trim(),
      });
      toast('供应商已更新', 'success');
    } else {
      await api.supplierCreate({
        name: form.name.trim(),
        phone: form.phone.trim(),
        note: form.note.trim(),
      });
      toast(`供应商「${form.name.trim()}」已创建`, 'success');
    }
    editorOpen.value = false;
    await load();
    emit('changed');
  } catch (e: unknown) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (busy.value || !target) return;
  busy.value = true;
  try {
    await api.supplierDelete(target.id);
    toast(`已删除「${target.name}」`, 'success');
    pendingDelete.value = null;
    await load();
    emit('changed');
  } catch (e: unknown) {
    // 主进程守卫（已有拿货单 / 付款记录）的报错要完整展示，不能一闪而过
    const msg = e instanceof Error ? e.message : String(e);
    pendingDelete.value = null;
    error.value = msg;
    toast(msg, 'error');
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
</script>

<style scoped>
.gd-supplier {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gd-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.gd-toolbar__hint {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}
.gd-toolbar__actions {
  flex-shrink: 0;
}

.gd-panel {
  flex: 1;
  min-height: 180px;
}
.gd-panel__empty {
  padding: 0;
}
.gd-c-ops {
  width: 100px;
  white-space: nowrap;
}
.gd-nowrap {
  white-space: nowrap;
}

.sup-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
