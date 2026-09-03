<script setup lang="ts">
import { ref, watch } from 'vue';
import { useOrderInsightStore } from '../store';
import { toast } from '@/core/services/toast';

const emit = defineEmits<{
  (e: 'goto-library'): void;
  (e: 'goto-summary'): void;
  (e: 'goto-correction'): void;
}>();

const store = useOrderInsightStore();

const STEPS = [
  { id: 1, label: '上传订单' },
  { id: 2, label: '图片识别' },
  { id: 3, label: '数据纠正' },
  { id: 4, label: '筛选统计' },
  { id: 5, label: '导出' },
] as const;

/** 当前所处步骤（1~5）：随导入/识别进度自动推进；点击已达成步骤可回到对应动作 */
const current = ref(1);

watch(
  // queueCounts.total>0 表示已有导入批次（含重启后恢复的遗留批次）；订单数用服务端 COUNT（orderTotal）
  () => [store.queueCounts.total, store.orderTotal, store.processing],
  () => {
    if (!store.queueCounts.total) {
      current.value = 1;
      return;
    }
    if (store.processing || !store.orderTotal) {
      if (current.value < 2) current.value = 2;
      return;
    }
    // 识别完成即视为已达成「筛选统计」，保证第 4 步可点击（第 5 步导出在数据汇总面板可直接操作）
    if (current.value < 4) current.value = 4;
  },
  { immediate: true },
);

/** 是否已完成（严格早于当前步） */
function isDone(s: number): boolean {
  return s < current.value;
}

function onStep(s: number) {
  if (s > current.value) return; // 未达成步骤不可点击
  switch (s) {
    case 1:
      if (store.processing) {
        toast('识别进行中，请先停止后再上传新文件', 'error');
        return;
      }
      current.value = 1;
      store.importExcel();
      break;
    case 2:
      if (store.processing) return;
      current.value = 2;
      store.runProcess();
      break;
    case 3:
      emit('goto-correction');
      break;
    case 4:
      current.value = 4;
      emit('goto-summary');
      break;
    case 5:
      current.value = 5;
      store.exportExcel();
      break;
  }
}
</script>

<template>
  <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] px-3 py-3 shadow-sm">
    <div class="flex items-center overflow-x-auto">
      <template v-for="(s, i) in STEPS" :key="s.id">
        <button
          class="flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45 enabled:hover:bg-[var(--wb-hover)]"
          :disabled="s.id > current"
          @click="onStep(s.id)"
        >
          <span
            class="flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium transition-colors"
            :class="
              isDone(s.id)
                ? 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)]'
                : s.id === current
                  ? 'bg-[var(--wb-primary-soft)] text-[var(--wb-primary)] ring-1 ring-[var(--wb-primary)]'
                  : 'bg-[var(--wb-surface-2)] text-[var(--wb-text-muted)]'
            "
          >
            {{ isDone(s.id) ? '✓' : s.id }}
          </span>
          <span class="hidden sm:inline" :class="s.id === current ? 'font-medium text-[var(--wb-text)]' : 'text-[var(--wb-text-muted)]'">
            {{ s.label }}
          </span>
        </button>
        <!-- 连接线：已走过高亮 -->
        <div
          v-if="i < STEPS.length - 1"
          class="mx-1 h-px min-w-5 flex-1 shrink-0"
          :class="s.id < current ? 'bg-[var(--wb-primary)]' : 'bg-[var(--wb-border)]'"
        ></div>
      </template>
    </div>
  </div>
</template>
