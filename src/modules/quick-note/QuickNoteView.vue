<template>
  <div class="h-full flex flex-col bg-[var(--wb-bg)]">
    <div class="flex-1 overflow-y-auto p-6">
      <div class="max-w-2xl mx-auto space-y-4">
        <div
          class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4 shadow-sm"
        >
          <textarea
            v-model="draft"
            rows="4"
            placeholder="写点什么…⌘S 或点击保存"
            class="w-full resize-none outline-none bg-transparent text-sm text-[var(--wb-text)] placeholder:text-[var(--wb-text-muted)]"
            @keydown.meta.s="onSaveKey"
          ></textarea>
          <div class="flex justify-end mt-2">
            <button
              class="h-8 px-3 rounded-md bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)] text-sm font-medium hover:opacity-90 transition-opacity"
              @click="save"
            >
              保存便签
            </button>
          </div>
        </div>

        <p v-if="!notes.length" class="text-center text-sm text-[var(--wb-text-muted)] py-8">
          还没有便签，写下第一条吧。
        </p>

        <ul class="space-y-2">
          <li
            v-for="note in notes"
            :key="note.id"
            class="group flex items-start gap-3 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-3 shadow-sm"
          >
            <p class="flex-1 whitespace-pre-wrap break-words text-sm text-[var(--wb-text)]">
              {{ note.text }}
            </p>
            <button
              class="opacity-0 group-hover:opacity-100 text-[var(--wb-text-muted)] hover:text-[var(--wb-danger)] transition-opacity text-xs"
              @click="remove(note.id)"
            >
              删除
            </button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useModuleStorage } from '@/core/services/storage';
import { toast } from '@/core/services/toast';

interface Note {
  id: string;
  text: string;
  createdAt: number;
}

// 模块私有命名空间持久化（与 excel-copy 互不污染）
const storage = useModuleStorage<{ notes: Note[] }>('quick-note');

const draft = ref('');
const notes = ref<Note[]>([]);

onMounted(async () => {
  try {
    const data = await storage.load();
    notes.value = data?.notes ?? [];
  } catch {
    notes.value = [];
  }
});

async function save() {
  const text = draft.value.trim();
  if (!text) {
    toast('便签内容不能为空', 'error');
    return;
  }
  notes.value = [{ id: Date.now().toString(), text, createdAt: Date.now() }, ...notes.value];
  await storage.save({ notes: notes.value });
  draft.value = '';
  toast('已保存', 'success');
}

async function remove(id: string) {
  notes.value = notes.value.filter((n) => n.id !== id);
  await storage.save({ notes: notes.value });
  toast('已删除', 'info');
}

function onSaveKey(e: KeyboardEvent) {
  e.preventDefault();
  save();
}
</script>
