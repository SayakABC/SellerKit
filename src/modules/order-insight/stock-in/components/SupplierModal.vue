<script setup lang="ts">
// 厂商弹窗：新建（name/phone/note）或编辑（仅 phone/note，name 保持唯一键不可改）
import { ref, watch, onMounted, nextTick } from 'vue';
import { useStockInStore } from '../store';

const store = useStockInStore();

const props = defineProps<{
  /** 编辑目标；null 表示新建 */
  editTarget?: { id: number; name: string; phone: string; note: string } | null;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const nameInput = ref<HTMLInputElement | null>(null);
const phoneInput = ref<HTMLInputElement | null>(null);
const name = ref('');
const phone = ref('');
const note = ref('');
const busy = ref(false);

watch(
  () => props.editTarget,
  (t) => {
    name.value = t?.name ?? '';
    phone.value = t?.phone ?? '';
    note.value = t?.note ?? '';
  },
  { immediate: true },
);

// 打开弹窗自动聚焦：新建聚焦名称，编辑聚焦电话（名称不可改）
onMounted(() => {
  nextTick(() => {
    (props.editTarget ? phoneInput.value : nameInput.value)?.focus();
  });
});

async function save() {
  if (!name.value.trim() && !props.editTarget) return;
  busy.value = true;
  try {
    let ok: boolean;
    if (props.editTarget) {
      ok = await store.updateSupplier(props.editTarget.id, phone.value, note.value);
    } else {
      ok = await store.createSupplier(name.value, phone.value, note.value);
    }
    if (ok) emit('close');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--wb-overlay)]" @click.self="emit('close')">
    <div class="w-[420px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] shadow-xl">
      <div class="flex items-center justify-between border-b border-[var(--wb-border)] px-4 py-3">
        <h3 class="text-sm font-semibold">{{ editTarget ? `编辑厂商 · ${editTarget.name}` : '新增厂商' }}</h3>
        <button class="text-[var(--wb-text-muted)] hover:text-[var(--wb-text)]" @click="emit('close')">✕</button>
      </div>
      <div class="space-y-3 px-4 py-4">
        <div v-if="!editTarget">
          <label class="mb-1 block text-xs text-[var(--wb-text-muted)]">名称（必填）</label>
          <input v-model="name" type="text" placeholder="如：广州某某服装厂" class="wb-input" ref="nameInput" @keyup.enter="save" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-[var(--wb-text-muted)]">电话</label>
          <input v-model="phone" type="text" placeholder="选填" class="wb-input" ref="phoneInput" @keyup.enter="save" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-[var(--wb-text-muted)]">备注</label>
          <input v-model="note" type="text" placeholder="选填" class="wb-input" @keyup.enter="save" />
        </div>
      </div>
      <div class="flex justify-end gap-2 border-t border-[var(--wb-border)] px-4 py-3">
        <button class="rounded-lg border border-[var(--wb-border)] px-3 py-1.5 text-xs hover:bg-[var(--wb-hover)]" @click="emit('close')">取消</button>
        <button
          class="rounded-lg bg-[var(--wb-primary)] px-3 py-1.5 text-xs font-medium text-[var(--wb-primary-contrast)] hover:bg-[var(--wb-primary-hover)] disabled:opacity-50"
          :disabled="busy || (!editTarget && !name.trim())"
          @click="save"
        >
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>
