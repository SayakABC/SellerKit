<template>
  <div class="flex-1 overflow-y-auto">
    <div v-if="store.filteredRecords.length === 0" class="flex items-center justify-center h-full text-[var(--wb-text-muted)] text-sm">
      暂无数据
    </div>
    <div v-else>
      <RecordItem
        v-for="record in store.filteredRecords"
        :key="record.id"
        :record="record"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useExcelCopyStore } from '../store';
import RecordItem from './RecordItem.vue';

const store = useExcelCopyStore();
</script>
