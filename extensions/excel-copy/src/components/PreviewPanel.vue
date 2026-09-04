<template>
  <div class="flex-1 flex flex-col bg-[var(--wb-surface)]">
    <!-- No selection -->
    <div v-if="!store.selectedRecord" class="flex-1 flex items-center justify-center text-[var(--wb-text-muted)]">
      <div class="text-center">
        <svg class="mx-auto h-12 w-12 text-[var(--wb-text-muted)] opacity-60 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
        </svg>
        <p>点击左侧记录预览内容</p>
      </div>
    </div>

    <!-- Preview content -->
    <div v-else class="flex-1 flex flex-col overflow-hidden">
      <!-- Header -->
      <div class="px-5 py-3 border-b border-[var(--wb-border)] flex items-center justify-between">
        <div>
          <h3 class="text-sm font-medium text-[var(--wb-text)]">内容预览</h3>
          <p class="text-xs text-[var(--wb-text-muted)] mt-0.5">
            模板: {{ store.activeTemplate?.name || '未选择' }}
          </p>
        </div>
        <span
          v-if="store.selectedRecord.used"
          class="px-2 py-0.5 text-xs bg-[var(--wb-success-soft)] text-[var(--wb-success)] rounded-full"
        >
          已使用
        </span>
        <span
          v-else
          class="px-2 py-0.5 text-xs bg-[var(--wb-surface-2)] text-[var(--wb-text-muted)] rounded-full"
        >
          未使用
        </span>
      </div>

      <!-- Template preview -->
      <div class="flex-1 overflow-y-auto px-5 py-4">
        <div class="mb-3">
          <label class="text-xs font-medium text-[var(--wb-text-muted)] uppercase tracking-wide">模板替换结果</label>
        </div>
        <div
          class="bg-[var(--wb-surface-2)] rounded-lg p-4 text-sm leading-relaxed whitespace-pre-wrap font-mono break-all"
          v-html="store.previewHtml.html"
        ></div>
      </div>

      <!-- Field details -->
      <div class="px-5 py-3 border-t border-[var(--wb-border)]">
        <details>
          <summary class="text-xs font-medium text-[var(--wb-text-muted)] cursor-pointer hover:text-[var(--wb-text)]">
            字段详情
          </summary>
          <div class="mt-2 grid grid-cols-2 gap-1.5 text-xs">
            <div
              v-for="(value, key) in store.selectedRecord.fields"
              :key="key"
              class="flex gap-1"
            >
              <span class="text-[var(--wb-text-muted)] font-medium flex-shrink-0">{{ key }}:</span>
              <span class="text-[var(--wb-text)] break-all">{{ value }}</span>
            </div>
          </div>
        </details>
      </div>

      <!-- Action buttons -->
      <div class="px-5 py-3 border-t border-[var(--wb-border)] flex gap-2">
        <button
          v-if="!store.selectedRecord.used"
          @click="store.copyAndMark(store.selectedRecord!)"
          class="flex-1 px-4 py-2 text-sm font-medium bg-[var(--wb-primary)] hover:bg-[var(--wb-primary-hover)] text-[var(--wb-primary-contrast)] rounded-md transition-colors"
        >
          复制并标记已使用
        </button>
        <button
          v-else
          @click="store.copyAndMark(store.selectedRecord!)"
          class="flex-1 px-4 py-2 text-sm font-medium border border-[var(--wb-border)] text-[var(--wb-text)] hover:bg-[var(--wb-hover)] rounded-md transition-colors"
        >
          仅复制
        </button>
        <button
          v-if="store.selectedRecord.used"
          @click="store.undo()"
          class="px-4 py-2 text-sm font-medium border border-[var(--wb-border)] text-[var(--wb-text)] hover:bg-[var(--wb-hover)] rounded-md transition-colors"
        >
          撤销
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useExcelCopyStore } from '../store';
const store = useExcelCopyStore();
</script>
