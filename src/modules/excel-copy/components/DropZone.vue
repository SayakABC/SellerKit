<template>
  <div
    class="flex-1 flex flex-col overflow-hidden relative"
    :class="{ 'drop-zone-active': isDragOver }"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <!-- Empty state -->
    <div
      v-if="store.records.length === 0 && !store.isLoading"
      class="flex-1 flex items-center justify-center"
      @click="store.selectExcelFile()"
    >
      <div
        class="border-2 border-dashed border-[var(--wb-border)] rounded-xl p-12 text-center transition-colors cursor-pointer hover:border-[var(--wb-primary)] hover:bg-[var(--wb-primary-soft)]"
        :class="{ 'border-[var(--wb-primary)] bg-[var(--wb-primary-soft)]': isDragOver }"
      >
        <svg class="mx-auto h-12 w-12 text-[var(--wb-text-muted)] mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <p class="text-[var(--wb-text)] text-lg">点击或拖拽 Excel 文件到此处</p>
        <p class="text-[var(--wb-text-muted)] text-sm mt-1">支持 .xlsx / .xls 格式</p>
      </div>
    </div>

    <!-- Content -->
    <slot v-else></slot>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useExcelCopyStore } from '../store';
import { toast } from '@/core/services/toast';
import { parseExcelBuffer } from '@/core/services/excel';

const store = useExcelCopyStore();
const isDragOver = ref(false);

function onDragOver(e: DragEvent) {
  isDragOver.value = true;
}

function onDragLeave(e: DragEvent) {
  isDragOver.value = false;
}

async function onDrop(e: DragEvent) {
  isDragOver.value = false;
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const file = files[0];
  if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
    toast('仅支持 .xlsx 格式', 'error');
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    await store.importExcel(parseExcelBuffer(buffer), file.name);
  } catch (err: any) {
    toast(`读取文件失败: ${err.message}`, 'error');
  }
}
</script>
