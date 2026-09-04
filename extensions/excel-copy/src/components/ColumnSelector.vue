<template>
  <!-- ToolBar 齿轮按钮：点击打开设置页并定位到"TV模版 · 显示列" -->
  <button
    v-if="!embedded"
    @click="openColumnSettings"
    class="p-1.5 text-[var(--wb-text-muted)] hover:text-[var(--wb-text)] hover:bg-[var(--wb-hover)] rounded transition-colors"
    title="选择显示列"
  >
    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  </button>

  <!-- 设置页内嵌：显示列选择面板 -->
  <div v-else class="h-full flex flex-col">
    <div class="px-3 py-2 border-b border-[var(--wb-border)] flex-shrink-0">
      <p class="text-xs font-medium text-[var(--wb-text-muted)] uppercase">选择显示列</p>
    </div>
    <div class="flex-1 overflow-y-auto py-1">
      <label
        v-for="field in store.allHeaders"
        :key="field"
        class="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--wb-hover)] cursor-pointer text-sm"
      >
        <input
          type="checkbox"
          :checked="store.isColumnVisible(field)"
          @change="store.toggleColumnVisibility(field)"
          class="rounded border-[var(--wb-border)] text-[var(--wb-primary)] focus:ring-[var(--wb-primary)]"
        />
        <span
          :class="store.derivedHeaders.includes(field) ? 'text-[var(--wb-accent)]' : 'text-[var(--wb-text)]'"
        >
          {{ field }}
        </span>
        <span
          v-if="store.derivedHeaders.includes(field)"
          class="ml-auto text-xs text-[var(--wb-accent)] opacity-70"
        >衍生</span>
      </label>
      <div
        v-if="store.allHeaders.length === 0"
        class="px-3 py-8 text-center text-sm text-[var(--wb-text-muted)]"
      >
        暂无列数据，请先导入 Excel 文件
      </div>
    </div>
    <div
      v-if="store.allHeaders.length > 0"
      class="px-3 py-2 border-t border-[var(--wb-border)] flex-shrink-0"
    >
      <button
        @click="selectAll"
        class="text-xs text-[var(--wb-primary)] hover:text-[var(--wb-primary-hover)] mr-3"
      >全选</button>
      <button
        @click="selectDefault"
        class="text-xs text-[var(--wb-primary)] hover:text-[var(--wb-primary-hover)]"
      >默认</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useExcelCopyStore } from '../store';

defineProps<{ embedded?: boolean }>();

const store = useExcelCopyStore();

/** 齿轮点击：打开全局设置页并定位到"TV模版 · 显示列" */
function openColumnSettings() {
  window.dispatchEvent(
    new CustomEvent('open-settings', { detail: { category: 'excel', tab: 'columns' } }),
  );
}

function selectAll() {
  store.allHeaders.forEach((h) => {
    if (!store.isColumnVisible(h)) {
      store.toggleColumnVisibility(h);
    }
  });
}

function selectDefault() {
  // 清除所有
  [...store.visibleColumns].forEach((h) => store.toggleColumnVisibility(h));
  // 恢复前2个原始列
  store.headers.slice(0, 2).forEach((h) => {
    if (!store.isColumnVisible(h)) {
      store.toggleColumnVisibility(h);
    }
  });
}
</script>
