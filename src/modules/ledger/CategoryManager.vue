<template>
  <div class="wb-mask" @click.self="close">
    <div class="wb-dialog wb-dialog--md" role="dialog" aria-modal="true" data-act="category-manager">
      <div class="wb-dialog__head">科目</div>

      <div class="wb-dialog__body lg-cats">
        <p v-if="error" class="wb-notice wb-notice--error" data-act="category-error">{{ error }}</p>
        <p class="wb-field__hint">
          科目是收支的归类（采购货款、房租水电…）。预置科目可以改名或停用，<b>不能删除</b> —— 历史条目要能读懂。
          收支类型定了就不能改（否则历史条目会从收入变成支出），要换类型请新建。
        </p>

        <section v-for="g in groups" :key="g.kind" class="lg-cat-col" :data-act="`cat-col-${g.kind}`">
          <header class="lg-cat-col__head">
            <span class="lg-cat-col__title">{{ KIND_LABEL[g.kind] }}</span>
            <span class="wb-muted">{{ g.rows.length }} 个</span>
          </header>

          <div class="lg-cat-add">
            <input
              v-model="addName[g.kind]"
              class="wb-input wb-input--sm"
              :data-act="`cat-add-input-${g.kind}`"
              :placeholder="`新增${KIND_LABEL[g.kind]}科目`"
              @keydown.enter.prevent="add(g.kind)"
            />
            <button
              class="wb-btn wb-btn--sm"
              type="button"
              :data-act="`cat-add-${g.kind}`"
              :disabled="busy || !addName[g.kind].trim()"
              @click="add(g.kind)"
            >
              添加
            </button>
          </div>

          <ul class="lg-cat-list" :data-act="`cat-list-${g.kind}`">
            <li v-for="c in g.rows" :key="c.id" class="lg-cat-row" :class="{ 'is-archived': c.archived }" :data-cat-id="c.id">
              <template v-if="editingId === c.id">
                <input
                  v-model="editingName"
                  class="wb-input wb-input--sm lg-cat-edit"
                  data-act="cat-rename-input"
                  @keydown.enter.prevent="saveRename(c)"
                />
                <button class="wb-link" type="button" data-act="cat-rename-save" :disabled="busy" @click="saveRename(c)">
                  保存
                </button>
                <button class="wb-link" type="button" :disabled="busy" @click="editingId = 0">取消</button>
              </template>
              <template v-else>
                <span class="lg-cat-name" data-act="cat-name">{{ c.name }}</span>
                <span v-if="c.builtin" class="wb-tag lg-cat-builtin">预置</span>
                <span v-if="c.archived" class="wb-tag">已停用</span>
                <span class="lg-cat-spacer"></span>
                <button class="wb-link" type="button" data-act="cat-rename" @click="startRename(c)">改名</button>
                <button class="wb-link" type="button" data-act="cat-archive" @click="toggleArchive(c)">
                  {{ c.archived ? '启用' : '停用' }}
                </button>
              </template>
            </li>
            <li v-if="!g.rows.length && !loading" class="lg-cat-empty wb-muted">还没有{{ KIND_LABEL[g.kind] }}科目</li>
          </ul>
        </section>
      </div>

      <div class="wb-dialog__foot">
        <button class="wb-btn" type="button" data-act="category-close" @click="close">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 「科目管理」（P1）。收/支两套科目**各自独立**（`kind` 是建表时定死的）：
// 收入科目只出现在收入条目下拉里，反之亦然 —— 混在一起选错，等于把支出记成收入。
import { computed, onMounted, reactive, ref } from 'vue';
import { toast } from '@/core/services/toast';
import * as api from './api';
import { KIND_LABEL } from './labels';
import type { LedgerCategoryRow, LedgerKind } from '@/types';

const emit = defineEmits<{ close: []; changed: [] }>();

const rows = ref<LedgerCategoryRow[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref('');

const addName = reactive<Record<LedgerKind, string>>({ income: '', expense: '' });
const editingId = ref(0);
const editingName = ref('');

const groups = computed(() =>
  (['expense', 'income'] as const).map((kind) => ({
    kind,
    rows: rows.value.filter((c) => c.kind === kind),
  }))
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    rows.value = await api.categories(undefined, true);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function add(kind: LedgerKind): Promise<void> {
  if (busy.value) return;
  const name = addName[kind].trim();
  if (!name) return;
  busy.value = true;
  error.value = '';
  try {
    await api.categoryUpsert({ kind, name });
    addName[kind] = '';
    toast(`已添加${KIND_LABEL[kind]}科目「${name}」`, 'success');
    await load();
    emit('changed');
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function startRename(c: LedgerCategoryRow): void {
  editingId.value = c.id;
  editingName.value = c.name;
}

async function saveRename(c: LedgerCategoryRow): Promise<void> {
  if (busy.value) return;
  const name = editingName.value.trim();
  if (!name || name === c.name) {
    editingId.value = 0;
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await api.categoryUpsert({ id: c.id, kind: c.kind, name, archived: c.archived });
    toast('科目已改名', 'success');
    editingId.value = 0;
    await load();
    emit('changed');
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function toggleArchive(c: LedgerCategoryRow): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.categoryUpsert({ id: c.id, kind: c.kind, name: c.name, archived: !c.archived });
    toast(c.archived ? `已启用「${c.name}」` : `已停用「${c.name}」`, 'success');
    await load();
    emit('changed');
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function close(): void {
  if (busy.value) return;
  emit('close');
}

onMounted(() => void load());
</script>

<style scoped>
.lg-cats {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.lg-cat-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}
.lg-cat-col__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.lg-cat-col__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
}
.lg-cat-add {
  display: flex;
  gap: 8px;
}
.lg-cat-add .wb-input {
  flex: 1;
}
.lg-cat-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.lg-cat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 2px 0;
  border-top: 1px solid var(--wb-border);
  font-size: 13px;
}
.lg-cat-row:first-child {
  border-top: 0;
}
.lg-cat-row.is-archived .lg-cat-name {
  color: var(--wb-text-muted);
  text-decoration: line-through;
}
.lg-cat-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lg-cat-builtin {
  flex-shrink: 0;
}
.lg-cat-spacer {
  flex: 1;
}
.lg-cat-edit {
  flex: 1;
}
.lg-cat-empty {
  padding: 6px 0;
  font-size: 12.5px;
}
</style>
