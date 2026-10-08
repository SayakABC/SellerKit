<template>
  <!-- 两栏工作台外壳（S0 骨架；S1 左栏换成专用组件；S2 右栏换成专用组件；S4 恒两栏）。
       左栏 = 自己的款（`pane-products`，`ProductPane` 紧凑列表 + 行展开），
       右栏 = 店铺商品池（`pane-pool`，`PoolPane` 队列 / 已映射）。

       ⚠️ 右栏原先带一个 `pool` 开关做**懒挂载**（理由：首屏停在「产品」页签时池栏看不见，
       不该白付一次全量订单聚合）。2026-10-08 S4 把两个页签合并成一个后，**该前提消失** ——
       进这一页就是进工作台，池栏上来就在屏幕上，那次聚合正是用户看得见的那一栏该做的事。
       于是开关连同 `.is-pool` / `.is-idle` 两套样式一起撤掉，改成**恒两栏**。
       （这是"前提消失"，不是"懒挂载不划算" —— 将来若再出现"池栏可能不可见"的形态，
       这个开关该回来，而不是把它永久删掉。）

       本外壳只做**布局**：`data-act` 名与网格不变，两个子组件各自管自己的数据。 -->
  <div class="gd-wb" data-act="goods-workbench">
    <section class="gd-wb__pane gd-wb__pane--products" data-act="pane-products">
      <ProductPane :refresh-nonce="refreshNonce" @select-product="currentProduct = $event" />
    </section>

    <!-- 池栏容器与内容都**常驻**（守卫断言两栏同时在 DOM 里、且首屏就有队列）。 -->
    <section class="gd-wb__pane gd-wb__pane--pool" data-act="pane-pool">
      <!-- 页级「刷新」也透传给右栏：页级刷新应当刷新**同屏**的每一栏，
           只刷左栏会让"我在右边看着队列、点刷新却什么都没变"。
           左栏的"当前款"同理 —— 右栏的「直连 / 对比」都落在它身上。 -->
      <PoolPane :refresh-nonce="refreshNonce" :product="currentProduct" />
    </section>
  </div>
</template>

<script setup lang="ts">
// 两栏工作台外壳：只做**布局**，不取数、不推导 —— 两个子视图各自管自己的数据
// （"只有一个数据源"的纪律不变）。
//
// 为什么用 `pool` 属性而不是在这里读页签：外壳不该知道"现在是哪个页签"——那是 `GoodsView` 的事。
// 外壳只知道"池栏现在该不该有内容"。
//
// ⚠️ 这里原先还有一层 `changed` / `products-changed` / `suppliers-changed` 的**事件转接**
//    （把子视图的变动报给 `GoodsView` 去重算页级指标条 + 页签徽标）。2026-10-08 指标条与徽标
//    一起撤掉后，那一层彻底没有消费者 —— 于是整条拆掉，而不是留一个"转发了但没人听"的空管道。
import { ref } from 'vue';
import ProductPane from './ProductPane.vue';
import PoolPane from './PoolPane.vue';

// `refreshNonce` 直接暴露给模板（`defineProps` 的绑定自动进模板作用域），无需解构。
defineProps<{
  /** 页级「刷新」信号，原样透传给两栏（值变化即重拉） */
  refreshNonce: number;
}>();

/**
 * 左栏的「当前款」（用户真的展开过的那一行；`null` = 没展开任何款）。
 *
 * 这是全页**唯一**的跨栏状态：分栏才有的动线（「关联到 S1」直连、对比认款）需要
 * "我现在看着哪一款"，而两个子组件互不认识 —— 只能由外壳转一手。
 *
 * ⚠️ 外壳**仍然不取数、不推导**：这里只是把左栏报上来的一个值原样递给右栏，
 * 不参与任何计算（"只有一个数据源"的纪律不变）。
 */
const currentProduct = ref<{ id: number; code: string; name: string } | null>(null);
</script>

<style scoped>
/* 网格：恒左右两栏（S4 起）。
   左栏给一个下限（420px）：再窄就放不下列（S1/S2 已裁列，这里保底 + 允许内部横向滚动）。
   左栏 40% / 右栏占余下 —— 右栏是队列（列更多、要装商品标题），宽一点更合适。 */
.gd-wb {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(420px, 40%) minmax(0, 1fr);
  gap: 16px;
}
/* 窄窗口：两栏改为**上下堆叠**（左在上），而不是让某一栏被挤没。
   ⚠️ 判据是"两栏都在"，不是"有一个消失"—— 守卫在 `scripts/goods-ui-smoke.mjs`（方案 §9-1）。 */
@media (max-width: 1180px) {
  .gd-wb {
    grid-template-columns: minmax(0, 1fr);
    grid-auto-rows: minmax(0, auto);
    overflow: auto;
  }
}

.gd-wb__pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
