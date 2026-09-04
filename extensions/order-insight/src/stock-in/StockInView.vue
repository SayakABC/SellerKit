<script setup lang="ts">
// 「拿货对账」子视图（内嵌于 order-insight 模块的 stock-in Tab）：
// Tab1 拿货（待拿货缺口 → 拿货单） / Tab2 对账（厂商卡片 + 流水）。
// 由父级 OrderInsightView 直接挂载并下发 request 意图（定位对账 / 生成拿货单草稿），不再走跨模块跳转。
import { ref, onMounted, watch } from 'vue';
import { useStockInStore, type StockInIntent } from './store';
import PurchaseTab from './components/PurchaseTab.vue';
import ReconTab from './components/ReconTab.vue';
import SupplierModal from './components/SupplierModal.vue';
import PaymentModal from './components/PaymentModal.vue';

const store = useStockInStore();
const activeTab = ref<'purchase' | 'recon'>('purchase');

/** 父级下发的进入意图（n 自增，重复动作也能被 watch 捕获） */
const props = defineProps<{ request?: StockInIntent | null }>();

/** 消费父级意图：进入即生效（含挂载前的首次请求，经 immediate 兜底） */
watch(
  () => props.request,
  (r) => {
    if (!r) return;
    if (r.sub) activeTab.value = r.sub;
    if (r.draftRows) store.newDraft(undefined, r.draftRows);
  },
  { immediate: true },
);

// 供应商弹窗（新建/编辑共用，editTarget 为 null 表示新建）
const supplierModalVisible = ref(false);
const supplierEditTarget = ref<{ id: number; name: string; phone: string; note: string } | null>(null);

function openSupplier(target?: { id: number; name: string; phone: string; note: string } | null) {
  supplierEditTarget.value = target ?? null;
  supplierModalVisible.value = true;
}

// 付款弹窗（状态在 store）
function openPayment(supplierId: number, type: 'payment' | 'refund') {
  store.paySupplierId = supplierId;
  store.payDefaultType = type;
  store.paymentModalOpen = true;
}

onMounted(() => {
  store.ensureLoaded();
});
</script>

<template>
  <!-- 根由父级 OrderInsightView 的 px-6/pt/pb 提供外边距；此处只负责纵向 flex 与子视图切换 -->
  <div class="flex h-full min-h-0 flex-col">
    <!-- 拿货 / 对账 子 Tab + 厂商管理入口：轻量工具行（不重复卡片底，避免与上层模块 Tab 卡片叠罗汉） -->
    <div class="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div class="flex items-center gap-1 rounded-lg bg-[var(--wb-surface-2)]/70 p-1">
        <button
          class="h-7 rounded-md px-3 text-xs font-medium transition-colors"
          :class="
            activeTab === 'purchase'
              ? 'bg-[var(--wb-surface)] text-[var(--wb-text)] shadow-sm ring-1 ring-[var(--wb-border)]'
              : 'text-[var(--wb-text-muted)] hover:text-[var(--wb-text)]'
          "
          @click="activeTab = 'purchase'"
        >
          拿货
        </button>
        <button
          class="h-7 rounded-md px-3 text-xs font-medium transition-colors"
          :class="
            activeTab === 'recon'
              ? 'bg-[var(--wb-surface)] text-[var(--wb-text)] shadow-sm ring-1 ring-[var(--wb-border)]'
              : 'text-[var(--wb-text-muted)] hover:text-[var(--wb-text)]'
          "
          @click="activeTab = 'recon'"
        >
          对账
        </button>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="store.loading" class="text-[10px] text-[var(--wb-text-muted)]">同步中…</span>
        <button
          class="rounded-lg border border-[var(--wb-border)] px-2.5 py-1 text-xs transition-colors hover:bg-[var(--wb-hover)]"
          @click="openSupplier()"
        >
          + 新增厂商
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      <PurchaseTab v-if="activeTab === 'purchase'" />
      <ReconTab v-else :on-open-supplier="openSupplier" :on-open-payment="openPayment" />
    </div>

    <SupplierModal v-if="supplierModalVisible" :edit-target="supplierEditTarget" @close="supplierModalVisible = false" />
    <PaymentModal v-if="store.paymentModalOpen" @close="store.paymentModalOpen = false" />
  </div>
</template>
