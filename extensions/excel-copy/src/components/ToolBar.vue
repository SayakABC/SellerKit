<template>
  <div class="bg-[var(--wb-surface)] border-b border-[var(--wb-border)] px-4 py-2 flex items-center gap-2 flex-wrap">
    <!-- 筛选 Tab（内容页左上角，WorkBuddy 自动化页风格） -->
    <div class="flex rounded-md overflow-hidden border border-[var(--wb-border)] text-sm flex-shrink-0">
      <button
        v-for="mode in filterModes"
        :key="mode.value"
        @click="store.filterMode = mode.value"
        :class="[
          'px-3 py-1.5 transition-colors',
          store.filterMode === mode.value
            ? 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)]'
            : 'bg-[var(--wb-surface)] text-[var(--wb-text)] hover:bg-[var(--wb-hover)]',
        ]"
      >
        {{ mode.label }} ({{ mode.count }})
      </button>
    </div>

    <!-- Column selector (gear) -->
    <div class="ml-auto">
      <ColumnSelector />
    </div>

    <!-- === Right: Actions === -->
    <!-- Undo (icon) -->
    <button
      @click="store.undo()"
      :disabled="store.undoStack.length === 0"
      class="p-1.5 text-sm text-[var(--wb-text-muted)] hover:text-[var(--wb-text)] disabled:opacity-40 disabled:cursor-not-allowed rounded transition-colors"
      title="撤销 (Ctrl+Z)"
    >
      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a5 5 0 015 5v2M3 10l4-4m-4 4l4 4" />
      </svg>
    </button>

    <!-- Reset (compact) -->
    <button
      @click="confirmReset"
      :disabled="store.usedCount === 0"
      class="px-2.5 py-1.5 text-sm text-[var(--wb-danger)] hover:bg-[var(--wb-danger-soft)] rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
      title="重置所有状态"
    >
      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      <span class="hidden sm:inline">重置</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useExcelCopyStore } from '../store';
import ColumnSelector from './ColumnSelector.vue';

const store = useExcelCopyStore();

const filterModes = computed(() => [
  { value: 'all' as const, label: '全部', count: store.totalCount },
  { value: 'unused' as const, label: '未使用', count: store.unusedCount },
  { value: 'used' as const, label: '已使用', count: store.usedCount },
]);

function confirmReset() {
  if (confirm('确定要重置所有记录状态吗？')) {
    store.resetAll();
  }
}
</script>
