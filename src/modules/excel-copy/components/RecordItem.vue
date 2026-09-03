<template>
  <div
    @click="store.selectRecord(record.id)"
    @dblclick="store.copyAndMark(record)"
    :class="[
      'px-4 py-2.5 cursor-pointer flex items-center gap-3 border-l-4 transition-colors',
      isSelected
        ? 'bg-[var(--wb-primary-soft)] border-[var(--wb-primary)]'
        : 'border-transparent hover:bg-[var(--wb-hover)]',
      record.used ? 'opacity-60' : '',
    ]"
  >
    <!-- Status icon -->
    <span v-if="record.used" class="text-[var(--wb-success)] flex-shrink-0">
      <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
      </svg>
    </span>
    <span v-else class="text-[var(--wb-text-muted)] opacity-50 flex-shrink-0">
      <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm0-2a6 6 0 100-12 6 6 0 000 12z" clip-rule="evenodd" />
      </svg>
    </span>

    <!-- First two field values -->
    <div class="flex-1 min-w-0">
      <span
        v-for="(key, idx) in displayFields"
        :key="key"
        :class="[
          'text-sm',
          record.used ? 'line-through text-[var(--wb-text-muted)]' : 'text-[var(--wb-text)]',
          idx > 0 ? 'ml-2' : '',
        ]"
      >
        <span class="text-[var(--wb-text-muted)] text-xs mr-1">{{ key }}:</span>
        <span class="truncate">{{ truncate(record.fields[key] || '', 30) }}</span>
      </span>
    </div>

    <!-- Quick copy -->
    <button
      @click.stop="store.copyAndMark(record)"
      class="flex-shrink-0 p-1 text-[var(--wb-text-muted)] hover:text-[var(--wb-primary)] transition-colors"
      :title="record.used ? '仅复制' : '复制并标记'"
    >
      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useExcelCopyStore } from '../store';
import type { RecordItem } from '../../../types';

const props = defineProps<{ record: RecordItem }>();
const store = useExcelCopyStore();

const isSelected = computed(() => store.selectedId === props.record.id);

const displayFields = computed(() => {
  // 使用 visibleColumns 确定显示的字段
  const cols = store.visibleColumns.length > 0
    ? store.visibleColumns
    : Object.keys(props.record.fields).slice(0, 2);
  return cols.filter((key) => key in props.record.fields);
});

function truncate(str: string, len: number) {
  return str.length > len ? str.slice(0, len) + '...' : str;
}
</script>
