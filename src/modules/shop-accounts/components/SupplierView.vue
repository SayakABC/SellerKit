<template>
  <div class="gd-supplier">
    <!-- 工具栏只留一个动作：新增。
         原这里有一句长说明（"这里维护供应商名单；「产品」页给款式指定用哪家…"）——
         2026-10-14 按"不要太多文案"撤掉：页面标题与左导航已经说清这是什么，
         解释性文字对不会用电脑的用户是噪音，对老用户是重复。 -->
    <div class="gd-toolbar">
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
            <!-- 整行可点开编辑（2026-10-14 交互重设计）：对不会用电脑的人，
                 "点这一行就能改"比"找到行尾那个小链接再点"好学得多。
                 行内的「编辑」按钮保留作显式入口（两个入口同一个动作，不涉状态分歧）。 -->
            <tr
              v-for="s in rows"
              :key="s.id"
              :data-supplier-id="s.id"
              class="gd-sup__row"
              title="点击修改这家供应商"
              @click="openEditor(s)"
            >
              <td class="wb-mono" data-act="s-name">{{ s.name }}</td>
              <td :class="{ 'wb-muted': !s.phone }" data-act="s-phone">{{ s.phone || '—' }}</td>
              <td :class="{ 'wb-muted': !s.note }" data-act="s-note">{{ s.note || '—' }}</td>
              <td class="wb-num" data-act="s-count">{{ productCountOf(s.id) }}</td>
              <td class="wb-muted gd-nowrap" data-act="s-created">{{ s.createdAt }}</td>
              <td class="gd-c-ops">
                <button
                  class="wb-link"
                  type="button"
                  data-act="s-edit"
                  @click.stop="openEditor(s)"
                >
                  编辑
                </button>
                <button
                  class="wb-link wb-link--danger"
                  type="button"
                  data-act="s-delete"
                  @click.stop="pendingDelete = s"
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
// 「基础数据 › 供应商」（2026-10-14 从「货与成本 › 供应商」页签迁入）。
//
// 语义来自 2026-09-27 的迁移：管理入口（新增/编辑/删除）收拢到产品域，
// 拿货单 / 付款 / 欠款对账等**业务视图**仍留在订单归类 —— 数据同源（`suppliers` 表）。
// 两条不能动的规则：
//   · 编辑只放开电话 / 备注：名称是 UNIQUE 键，改它会让历史拿货单指向别处；
//   · 删除有拿货单 / 付款记录时由主进程拒绝，错误原样展示（**不能只弹 toast 一闪而过**，
//     用户要照着提示去处理）。
import { computed, onMounted, reactive, ref } from 'vue';
// ⚠️ 2026-10-14：本组件从「货与成本」页签迁入「基础数据」模块（维护类功能只留一个入口）。
//    取数仍走 goods 域的 api（suppliers 表的唯一读写处没动）—— 跨模块 import 是刻意的：
//    「代码家在基础数据、数据层在 goods 域」比"为了少一行 import把页面留在业务模块里"好。
import * as api from '@/modules/goods/api';
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
  justify-content: flex-end;
}
.gd-toolbar__actions {
  flex-shrink: 0;
}
/* 整行可点（2026-10-14）：指针 + hover 底色给"这一行可以点"的 affordance。
   行内两个链接按钮各自 stopPropagation，不会出现"点删除却打开编辑"。 */
.gd-sup__row {
  cursor: pointer;
}
.gd-sup__row:hover {
  background: var(--wb-hover);
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
