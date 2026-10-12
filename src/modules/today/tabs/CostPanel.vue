<template>
  <!-- 同上：复用「算钱」模块的整页视图，只藏页头 + 传刷新信号。 -->
  <OrderCostView embedded :refresh-token="token" :import-date="day" @go-import="go('import')" />
</template>

<script setup lang="ts">
import OrderCostView from '@/modules/order-cost/OrderCostView.vue';
import { localDayKey } from '@/lib/localDay';
import { useShipping } from '../flowCtx';

// 同 `PurchasePanel` 里的拣货清单：`token` 让保活的页签在新数据到来时重算；`go-import` 让空态的
// 「去导订单」切到导入页签，而不是跳回本页（前身是 `switchModule('today')`）。
//
// ⚠️ `day` = 发货台的**每日口径**：内嵌形态只算**今天导入**的订单行（第 1–3 步按导入日）。
//    独立打开「算钱」模块时（不经本组件）不传 ⇒ 全库。两者都给 `oc-scope` 标签写清楚。
const { token, go } = useShipping();
const day = localDayKey();
</script>
