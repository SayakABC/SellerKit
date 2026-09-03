<template>
  <div
    class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] shadow-sm overflow-hidden"
  >
    <div class="px-4 py-3 flex items-center gap-3 border-b border-[var(--wb-border)]">
      <span class="text-sm font-medium text-[var(--wb-text)]">订单明细</span>
      <input
        v-model="detailQuery"
        class="h-8 w-64 rounded-lg border border-[var(--wb-border)] bg-transparent px-3 text-sm text-[var(--wb-text)] outline-none focus:border-[var(--wb-primary)]"
        placeholder="搜索订单号 / 店铺 / 款式 / 颜色…"
      />
      <span class="ml-auto text-xs text-[var(--wb-text-muted)]">{{ store.detailTotal }} 条</span>
    </div>

    <p
      v-if="!store.orderTotal"
      class="text-center text-sm text-[var(--wb-text-muted)] py-12"
    >
      暂无订单数据，请先在步骤条「① 上传订单」导入 Excel。
    </p>

    <template v-else>
      <table class="w-full text-sm">
        <thead class="text-xs text-[var(--wb-text-muted)] border-b border-[var(--wb-border)]">
          <tr>
            <th class="text-left font-normal px-4 py-2 w-20">主图</th>
            <th class="text-left font-normal px-4 py-2 w-56">订单</th>
            <th class="text-left font-normal px-4 py-2">产品</th>
            <th class="text-left font-normal px-4 py-2 w-32">款编码</th>
            <th class="text-left font-normal px-4 py-2 w-28">状态</th>
            <th class="text-left font-normal px-4 py-2 w-20">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="store.detailLoading" class="border-b border-[var(--wb-border)]">
            <td colspan="6" class="px-4 py-8 text-center text-xs text-[var(--wb-text-muted)]">加载中…</td>
          </tr>
          <tr v-else-if="!store.detailRows.length" class="border-b border-[var(--wb-border)]">
            <td colspan="6" class="px-4 py-8 text-center text-xs text-[var(--wb-text-muted)]">
              {{ detailQuery.trim() ? '没有匹配的订单' : '暂无订单数据' }}
            </td>
          </tr>
          <tr
            v-for="o in store.detailRows"
            :key="o.id"
            class="border-b border-[var(--wb-border)] last:border-0 hover:bg-[var(--wb-hover)]"
          >
            <!-- 主图 -->
            <td class="px-4 py-2.5 align-middle">
              <OrderThumb :path="o.localPath" size="md" />
            </td>

            <!-- 订单信息：订单号 + 店铺 · 时间 · 尺寸 -->
            <td class="px-4 py-2.5 align-middle">
              <div class="font-medium text-[var(--wb-text)] leading-tight truncate">{{ o.orderNo }}</div>
              <div
                class="mt-1 text-xs text-[var(--wb-text-muted)] leading-tight truncate"
                :title="[o.shop, o.orderTime, o.size].filter(Boolean).join(' · ')"
              >
                {{ [o.shop, o.orderTime, o.size].filter(Boolean).join(' · ') || '—' }}
              </div>
            </td>

            <!-- 产品信息：款式 + 颜色 / logo -->
            <td class="px-4 py-2.5 align-middle">
              <div class="text-[var(--wb-text)] leading-tight truncate">
                {{ o.styleName || o.category || '—' }}
              </div>
              <div class="mt-1 text-xs text-[var(--wb-text-muted)] leading-tight truncate">
                <template v-if="o.styleColor || o.color">{{ o.styleColor || o.color }}</template>
                <template v-if="o.logo"> · {{ o.logo }}</template>
                <template v-if="!o.styleColor && !o.color && !o.logo">—</template>
              </div>
            </td>

            <!-- 款编码 -->
            <td class="px-4 py-2.5 align-middle">
              <span
                v-if="o.styleCode"
                class="inline-block px-1.5 py-0.5 rounded bg-[var(--wb-primary-soft)] text-[var(--wb-primary)] text-xs font-medium whitespace-nowrap"
              >
                {{ o.styleCode }}
              </span>
              <span v-else class="text-xs text-[var(--wb-text-muted)]">—</span>
            </td>

            <!-- 发货状态 -->
            <td class="px-4 py-2.5 align-middle">
              <button
                class="inline-flex items-center gap-1.5 rounded-full border border-[var(--wb-border)] bg-[var(--wb-surface-2)] px-2.5 py-0.5 text-xs hover:bg-[var(--wb-hover)] whitespace-nowrap"
                :title="o.status === 'shipped' ? '点击改为未发货' : '点击标记为已发货'"
                @click="toggleStatus(o)"
              >
                <span
                  class="h-1.5 w-1.5 rounded-full"
                  :class="o.status === 'shipped' ? 'bg-[var(--wb-success)]' : 'bg-[var(--wb-warning)]'"
                ></span>
                <span
                  :class="o.status === 'shipped' ? 'text-[var(--wb-success)]' : 'text-[var(--wb-warning)]'"
                >
                  {{ o.status === 'shipped' ? '已发货' : '未发货' }}
                </span>
              </button>
            </td>

            <!-- 操作 -->
            <td class="px-4 py-2.5 align-middle">
              <button
                class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors whitespace-nowrap"
                :class="
                  confirmDeleteId === o.id
                    ? 'bg-[var(--wb-danger)] text-white font-medium'
                    : 'text-[var(--wb-danger)] hover:bg-[var(--wb-danger-soft)]'
                "
                :title="confirmDeleteId === o.id ? '再次点击确认删除' : '删除该订单'"
                @click="requestDelete(o)"
              >
                {{ confirmDeleteId === o.id ? '确认删除？' : '删除' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 分页（主进程按 offset/limit 返回；行级操作后 store.lightSync 自动重载当前页） -->
      <div
        v-if="store.detailTotal > PAGE_SIZE"
        class="flex items-center justify-end gap-2 border-t border-[var(--wb-border)] px-4 py-2 text-xs text-[var(--wb-text-muted)]"
      >
        <span>共 {{ store.detailTotal }} 条 · 第 {{ store.detailPageNo }} / {{ totalPages }} 页</span>
        <button
          class="rounded border border-[var(--wb-border)] px-2 py-0.5 transition-colors hover:bg-[var(--wb-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="store.detailPageNo <= 1 || store.detailLoading"
          @click="store.loadDetailPage(store.detailPageNo - 1)"
        >上一页</button>
        <button
          class="rounded border border-[var(--wb-border)] px-2 py-0.5 transition-colors hover:bg-[var(--wb-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="store.detailPageNo >= totalPages || store.detailLoading"
          @click="store.loadDetailPage(store.detailPageNo + 1)"
        >下一页</button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useOrderInsightStore } from '../store';
import OrderThumb from './OrderThumb.vue';
import type { OrderRecord, OrderStatus } from '@/types';

const store = useOrderInsightStore();
const PAGE_SIZE = 50;

/** 明细搜索（防抖后由 store 下沉到主进程 LIKE，服务端分页） */
const detailQuery = ref('');
watch(detailQuery, (q) => {
  store.setDetailSearch(q);
});

const totalPages = computed(() => Math.max(1, Math.ceil(store.detailTotal / PAGE_SIZE)));

/** 行内切换发货状态（未发货 ⇄ 已发货）；store 内即时更新当前页行并轻量同步 */
async function toggleStatus(o: OrderRecord) {
  if (o.id === undefined) return;
  const next: OrderStatus = o.status === 'shipped' ? 'pending' : 'shipped';
  await store.setOrderStatus(o.id, next);
}

/** 当前处于「确认删除」态的行 id（二次点击才真正删除，3s 未确认自动复位） */
const confirmDeleteId = ref<number | null>(null);
let confirmTimer: ReturnType<typeof setTimeout> | undefined;

function requestDelete(o: OrderRecord) {
  if (o.id === undefined) return;
  if (confirmDeleteId.value === o.id) {
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = undefined;
    }
    confirmDeleteId.value = null;
    store.deleteOrder(o.id);
    return;
  }
  confirmDeleteId.value = o.id;
  if (confirmTimer) clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => {
    confirmDeleteId.value = null;
    confirmTimer = undefined;
  }, 3000);
}

onMounted(() => {
  if (!store.detailRows.length) store.loadDetailPage(1);
});
</script>
