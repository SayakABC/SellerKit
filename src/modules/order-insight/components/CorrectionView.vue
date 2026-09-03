<template>
  <div class="space-y-3">
    <!-- 说明与进度 -->
    <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] px-4 py-3 shadow-sm flex items-center gap-3">
      <span class="text-sm text-[var(--wb-text)]">
        核对识别结果：有误的修改后点「保存并归类」（改款 / 颜色自动重匹配款编码）；无需修改的点「确认无误」直接完成核对。已核对的订单不再出现在列表。
      </span>
      <div class="ml-auto flex items-center gap-3 shrink-0">
        <span class="text-xs text-[var(--wb-text-muted)]">
          待纠正 <b class="font-medium text-[var(--wb-primary)]">{{ store.pendingTotal }}</b> 条
          <template v-if="doneCount > 0">（已核对 {{ doneCount }} 条）</template>
        </span>
        <button
          class="h-8 px-3 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-[var(--wb-primary-soft)] text-[var(--wb-primary)] hover:bg-[var(--wb-primary)] hover:text-[var(--wb-primary-contrast)]"
          :disabled="busyAll || store.pendingTotal === 0"
          title="识别准确率高时，把剩余待核对订单一次性全部标记为已核对（不改动识别结果）"
          @click="confirmAll"
        >
          {{ busyAll ? '确认中…' : '全部确认无误' }}
        </button>
      </div>
    </div>

    <!-- 搜索过滤（关键字下沉到主进程 LIKE，服务端分页） -->
    <div class="flex items-center gap-2">
      <input
        v-model="query"
        class="h-9 flex-1 rounded-lg border border-[var(--wb-border)] bg-[var(--wb-surface)] px-3 text-sm text-[var(--wb-text)] outline-none focus:border-[var(--wb-primary)]"
        placeholder="搜索订单号 / 店铺 / 款式 / 颜色…"
      />
      <span class="text-xs text-[var(--wb-text-muted)]">{{ store.pendingTotal }} 条</span>
    </div>

    <!-- 纠正列表（仅待纠正；主进程按页返回，每页窗口渲染） -->
    <div v-if="store.pendingRows.length" class="space-y-3">
      <CorrectionRow v-for="o in store.pendingRows" :key="o.id" :order="o" />
    </div>

    <!-- 分页（「全部确认无误」作用于全部待纠正，不受分页影响） -->
    <div
      v-if="store.pendingTotal > PAGE_SIZE"
      class="flex items-center justify-end gap-2 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] px-4 py-2 text-xs text-[var(--wb-text-muted)] shadow-sm"
    >
      <span>共 {{ store.pendingTotal }} 条 · 第 {{ store.pendingPageNo }} / {{ totalPages }} 页</span>
      <button
        class="rounded border border-[var(--wb-border)] px-2 py-0.5 transition-colors hover:bg-[var(--wb-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="store.pendingPageNo <= 1 || store.pendingLoading"
        @click="store.loadPendingPage(store.pendingPageNo - 1)"
      >上一页</button>
      <button
        class="rounded border border-[var(--wb-border)] px-2 py-0.5 transition-colors hover:bg-[var(--wb-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="store.pendingPageNo >= totalPages || store.pendingLoading"
        @click="store.loadPendingPage(store.pendingPageNo + 1)"
      >下一页</button>
    </div>

    <p v-else class="text-center text-sm text-[var(--wb-text-muted)] py-12">
      {{ !store.orderTotal ? '暂无订单数据，请先在「概览」导入订单并完成识别归类' : query.trim() ? '没有匹配的订单' : '全部订单已核对完成' }}
    </p>

    <!-- 完成纠正，进入下一步 -->
    <div
      v-if="store.orderTotal"
      class="flex items-center justify-between rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] px-4 py-3 shadow-sm"
    >
      <span v-if="store.pendingTotal > 0" class="text-xs text-[var(--wb-warning)]">
        还有 {{ store.pendingTotal }} 条待核对（不影响继续下一步）
      </span>
      <span v-else class="text-xs text-[var(--wb-success)]">全部订单已核对完成</span>
      <button
        class="h-9 px-4 rounded-lg bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)] text-sm font-medium hover:opacity-90 transition-opacity"
        @click="emit('goto-summary')"
      >
        完成纠正，进入筛选统计 →
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import { useOrderInsightStore } from '../store';
import CorrectionRow from './CorrectionRow.vue';

const emit = defineEmits<{ (e: 'goto-summary'): void }>();

const store = useOrderInsightStore();
const query = ref('');
const busyAll = ref(false);
const PAGE_SIZE = 20;

/** 已核对数（服务端计数口径：全部订单 - 待纠正） */
const doneCount = computed(() => Math.max(store.orderTotal - store.pendingTotal, 0));

const totalPages = computed(() => Math.max(1, Math.ceil(store.pendingTotal / PAGE_SIZE)));

/** 一键确认：把全部待核对订单标记为已核对（不修改识别字段），二次确认防误触；
 * 走主进程一次 UPDATE（markAllCorrected），避免把数万行 id 经 IPC 传回 */
async function confirmAll() {
  const count = store.pendingTotal;
  if (!count || busyAll.value) return;
  if (!window.confirm(`将把 ${count} 条待核对订单直接标记为已核对，不改动任何识别结果。确认？`)) return;
  busyAll.value = true;
  try {
    const updated = await store.markAllCorrected();
    if (updated > 0) toast.success(`已确认 ${updated} 条订单`);
    else toast.info('没有需要确认的待核对订单');
  } finally {
    busyAll.value = false;
  }
}

// 搜索输入：防抖后由 store 下沉到主进程 LIKE（回第 1 页）
watch(query, (q) => {
  store.setPendingSearch(q);
});

onMounted(() => {
  // 进入纠正 Tab 加载第 1 页（行级操作后的自动重载由 store.lightSync 负责）
  if (!store.pendingRows.length) store.loadPendingPage(1);
});
</script>
