<template>
  <!-- 同上：复用「算钱」模块的整页视图，只藏页头 + 传刷新信号。 -->
  <OrderCostView embedded :refresh-token="token" @go-import="go('import')" />
</template>

<script setup lang="ts">
import OrderCostView from '@/modules/order-cost/OrderCostView.vue';
import { useShipping } from '../flowCtx';

// 同 PickingPanel：`token` 让保活的页签在新数据到来时重算；`go-import` 让空态的
// 「去导订单」切到导入页签，而不是跳回本页（前身是 `switchModule('today')`）。
const { token, go } = useShipping();
</script>
