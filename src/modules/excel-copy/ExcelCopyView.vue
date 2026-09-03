<template>
  <div class="h-full flex flex-col bg-[var(--wb-bg)]" @keydown="handleKeydown">
    <div v-if="store.isLoading" class="flex-1 flex items-center justify-center">
      <div class="flex flex-col items-center gap-3">
        <div class="animate-spin rounded-full h-10 w-10 border-b-2 border-[var(--wb-primary)]"></div>
        <span class="text-[var(--wb-text-muted)]">加载中...</span>
      </div>
    </div>
    <div v-else class="flex-1 flex overflow-hidden p-4">
      <div class="flex-1 flex min-w-0 overflow-hidden wb-card">
        <SplitPane :left-ratio="60">
        <template #left>
          <ToolBar />
          <DropZone>
            <RecordList />
          </DropZone>
        </template>
        <template #right>
          <PreviewPanel />
        </template>
        </SplitPane>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useExcelCopyStore } from './store';
import ToolBar from './components/ToolBar.vue';
import DropZone from './components/DropZone.vue';
import RecordList from './components/RecordList.vue';
import PreviewPanel from './components/PreviewPanel.vue';
import SplitPane from '@/core/layout/SplitPane.vue';

const store = useExcelCopyStore();

onMounted(() => {
  store.init();
  document.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
});

function handleKeydown(e: KeyboardEvent) {
  const list = store.filteredRecords;
  if (!list.length) return;

  const currentIdx = list.findIndex((r) => r.id === store.selectedId);

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const nextIdx = currentIdx < list.length - 1 ? currentIdx + 1 : 0;
    store.selectRecord(list[nextIdx].id);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prevIdx = currentIdx > 0 ? currentIdx - 1 : list.length - 1;
    store.selectRecord(list[prevIdx].id);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (store.selectedRecord) {
      store.copyAndMark(store.selectedRecord);
    }
  } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    store.undo();
  }
}
</script>
