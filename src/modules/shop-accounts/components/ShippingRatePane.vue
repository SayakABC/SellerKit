<script setup lang="ts">
// src/modules/shop-accounts/components/ShippingRatePane.vue
// 「基础数据 › 物流运费」—— 2026-10-15 由 UI 岛 `ui-plugins/shipping-rate`（v1.3.1）
// 回收为内建资料项。岛的四个视图（运费查询 / 运价表 / 按订单试算 / 按产品试算）
// 原样成为本 pane 内的四个页签，交互与判据一条没放宽（冒烟断言随之搬到
// `scripts/shipping-rate-ui-smoke.mjs`，改跑宿主产物 + 假 electronAPI）。
//
// 为什么是一个资料项而不是四个：四页回答的是**同一份运价表**的四种用法
// （按克重 / 看表 / 按订单 / 按产品），合成一个入口用户才不需要记"试算在哪个岛"。
//
// ── 分工（这一层只做外壳，别把业务搬进来） ──────────────────────────────
//   · 状态与全部动作：`../shipRateStore.ts`（岛 dist/store.js 的 Pinia 化）；
//   · 计价/解析/取数：`@/core/services/shipRateOps`（岛桥 DB_OPS 的唯一实现，内建后直接调）；
//   · 四个页签组件只消费 store 渲染，**不做任何算术**（金额一律来自 op 返回值）。
import { onMounted, ref } from 'vue';
import { useShipRateStore } from '../shipRateStore';
import ShipRateQuoteTab from './ShipRateQuoteTab.vue';
import ShipRateRatesTab from './ShipRateRatesTab.vue';
import ShipRateOrdersTab from './ShipRateOrdersTab.vue';
import ShipRateProductsTab from './ShipRateProductsTab.vue';

const store = useShipRateStore();

/** 当前页签（会话内状态，不落盘 —— 岛时代的 app.tab 同样不落盘） */
const tab = ref<'quote' | 'rates' | 'orders' | 'products'>('quote');

const TABS: Array<{ id: typeof tab.value; name: string }> = [
  { id: 'quote', name: '运费查询' },
  { id: 'rates', name: '运价表' },
  { id: 'orders', name: '按订单试算' },
  { id: 'products', name: '按产品试算' },
];

onMounted(() => {
  // 首次进入跑完整初始化（读偏好 + 取宿主快照 + 算一次）；
  // 重复进入只刷新宿主侧（resync 不重读偏好，见 store 内注释）。
  if (!store.ready) void store.init();
  else void store.resync();
});
</script>

<template>
  <div class="srp" data-act="shipping-rate-pane">
    <!-- 页签用分段控件而不是四个左导航项：它们是同一份运价表的四面，
         分段控件在视觉上说"这是互斥视图"（同「货与成本」工作台的分页签约定）。 -->
    <div class="wb-seg srp__tabs" role="tablist" aria-label="物流运费">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        class="wb-seg__item"
        :data-act="`ship-tab-${t.id}`"
        :class="{ 'is-on': tab === t.id }"
        :aria-selected="tab === t.id"
        @click="tab = t.id"
      >
        {{ t.name }}
      </button>
    </div>

    <div class="srp__body">
      <ShipRateQuoteTab v-if="tab === 'quote'" />
      <ShipRateRatesTab v-else-if="tab === 'rates'" />
      <ShipRateOrdersTab v-else-if="tab === 'orders'" />
      <ShipRateProductsTab v-else-if="tab === 'products'" />
    </div>
  </div>
</template>

<style scoped>
.srp {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
}
.srp__tabs {
  flex-shrink: 0;
}
.srp__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
</style>
