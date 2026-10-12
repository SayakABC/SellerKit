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
  <!-- ⚠️ 外壳的根元素从 `.gd-wb` 换成了这一层：首次动线那张卡要**横跨两栏**、压在它们上面，
       而 `.gd-wb` 是两列栅格 —— 把卡塞进去它只会落进左栏那一格（并排形态下就成了左栏里的一张卡）。
       `.gd-wb` 本身一个属性都没改，`data-act="goods-workbench"` 也还在它身上
       （既有断言按 `data-act` 挂，不按层级挂 ⇒ 这一层包装不会让它们失配）。 -->
  <div class="gd-wb-shell">
    <!-- 只在**全新库**出现（零款 + 队列已拉过且为空），做完第 1 步自己就消失。
         判据在 `../firstRun.ts`（纯函数 + 单测），这里只做原样转手 ——
         外壳仍然**不推导**（两个数字分别来自左右两栏，外壳是唯一同时拿到它们的地方）。 -->
    <FirstRunCard
      v-if="showFirstRun"
      @import-orders="goImportOrders"
      @open-registry="navigate(GOODS_TAB_REGISTRY)"
    />

    <div class="gd-wb" data-act="goods-workbench">
      <section class="gd-wb__pane gd-wb__pane--products" data-act="pane-products">
        <ProductPane
          :refresh-nonce="refreshNonce"
          :relate-count="relateCount"
          :queue-empty="queueEmpty"
          @select-product="currentProduct = $event"
          @relate-request="relateNonce += 1"
          @import-orders="goImportOrders"
          @styles-total="stylesTotal = $event"
        />
      </section>

      <!-- 池栏容器与内容都**常驻**（守卫断言两栏同时在 DOM 里、且首屏就有队列）。 -->
      <section class="gd-wb__pane gd-wb__pane--pool" data-act="pane-pool">
        <!-- 页级「刷新」也透传给右栏：页级刷新应当刷新**同屏**的每一栏，
             只刷左栏会让"我在右边看着队列、点刷新却什么都没变"。
             左栏的"当前款"同理 —— 右栏的「直连 / 对比」都落在它身上。 -->
        <PoolPane
          :refresh-nonce="refreshNonce"
          :product="currentProduct"
          :navigate="navigate"
          :relate-nonce="relateNonce"
          @selection-changed="relateCount = $event"
          @queue-groups="queueGroups = $event"
        />
      </section>
    </div>
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
import { computed, ref } from 'vue';
import ProductPane from './ProductPane.vue';
import PoolPane from './PoolPane.vue';
import FirstRunCard from './FirstRunCard.vue';
import { shouldShowFirstRunCard } from '../firstRun';
import { GOODS_TAB_REGISTRY, type GoodsTabId } from '../tabs';
import { switchModule } from '@/core/services/shell';

// `refreshNonce` 直接暴露给模板（`defineProps` 的绑定自动进模板作用域），无需解构。
defineProps<{
  /** 页级「刷新」信号，原样透传给两栏（值变化即重拉） */
  refreshNonce: number;
  /**
   * 请求切到本页的另一个页签（由 `GoodsView` 的 `goTab` 提供）。
   *
   * 为什么是"外壳转手的回调"而不是右栏直接 import 页签枚举：**外壳不该知道有哪几个页签**
   * （那是 `GoodsView` 的事，同 `refreshNonce` 的边界）。右栏需要它是因为"店铺未归一"那几行
   * 的出口在「店铺登记」页签上 —— 没有这个回调，右栏只能写一句"请自己去别处登记"，
   * 那正是 2026-10-08 走查里的死胡同。
   */
  navigate: (tab: GoodsTabId) => void;
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

/**
 * 右栏**已勾选**的待关联商品数（左栏展开区「认到本款」的亮/灭由它决定）。
 *
 * 和 `currentProduct` 同一个道理：这个数字住在右栏的 `useSkuPool` 里，左栏拿不到也不该拿到 ——
 * 外壳只做**原样转手**，不参与任何计算（"只有一个数据源"的纪律不变）。
 * 它必须过外壳这一手，因为两个子组件互不认识。
 */
const relateCount = ref(0);

/**
 * 「认到本款」的信号（自增 nonce，同 `refreshNonce` 的写法）。
 *
 * 方向与 `relateCount` 相反（左 → 右）：左栏只发信号，**写库的路径仍只有右栏那一条**
 * （`relateToSelected` → `commitMap`：单事务、行级失败回传、写完重拉队列）。
 * 外壳不替任何一方写库，只负责把信号递过去。
 */
const relateNonce = ref(0);

/**
 * 首次动线的两个输入（都来自子栏的**原样转手**，外壳自己不取数）。
 *
 * ⚠️ 各自保留 `null` 这一态：`null` = 那个数**还没拉到**，`0` = 真的是零。
 * 两者混起来就是 2026-10-08 记过的那条现行犯（把 `null` 当 0，界面会说出
 * "都认完了"这种它不知道的结论）。判据本身在 `../firstRun.ts`，本文件不重写一遍。
 */
const stylesTotal = ref<number | null>(null);
const queueGroups = ref<number | null>(null);

const showFirstRun = computed(() =>
  shouldShowFirstRunCard({ stylesTotal: stylesTotal.value, queueGroups: queueGroups.value })
);

/**
 * 队列是不是**已拉过且为空**（`null` = 还没拉过）。只给左栏空态排"先做哪个"的顺序用。
 *
 * 这里**不是**把 `queueGroups === 0` 直接写进模板：模板里那三个分支（true / false / null）
 * 各自对应一句不同的话，把判据摊在模板里迟早会写成 `!queueGroups` —— 那句会把
 * "还没拉过"当成"没有待办"，正是本文件上面反复记过的那条现行犯。
 */
const queueEmpty = computed<boolean | null>(() =>
  queueGroups.value === null ? null : queueGroups.value === 0
);

/**
 * 第 1 步的出口：跨模块跳到「发货台」导订单。
 *
 * 判据同 `useSkuPool.goToday`：订单导入不在这一页，也不该在这一页再做一个 —— 跳过去是诚实的。
 * 外壳自己 import 而不是让卡片 import：卡片不认识模块表（同 `navigate` 的分工）。
 */
function goImportOrders(): void {
  switchModule('today');
}
</script>

<style scoped>
/* 外壳：卡 + 两栏工作台，纵向排布（卡按内容定高，工作台吃掉剩下全部高度）。 */
.gd-wb-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

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
    /* ⚠️ 行必须**按内容定高**，多出来的高度交给容器自己滚。
       这里原先写的是 `minmax(0, auto)`：那个下限 0 允许行被压扁到比内容还矮 —— 左栏的工具栏
       一换行、空态一渲染，内容就溢出格子，而 `.wb-panel` 是 `overflow: hidden` ⇒ 空态的文案与
       按钮被**静默裁掉**（无滚动条、无报错），后面那一栏又正好叠在它上面。
       症状：**全新安装的默认窗口就落在这个断点以下**，"导入 Excel / 新增产品"这两个第一屏唯一
       该点的按钮物理上点不到（2026-10-08 真机走查实测：elementFromPoint 命中的是 `SPAN.wb-metric`）。
       `align-content: start` 也不能省：默认的 stretch 会把两行摊开、把每栏拉到半屏高，
       表头与行之间被撑出几百 px 空白（本仓 2026-10-03 记过的同一个坑）。 */
    /* ⚠️ 行高必须写 `max-content`，**不能**写 `auto`（也不是 `minmax(0, auto)`）：
       `auto` 轨道的基准尺寸来自栅格项的"最小贡献"，而两个子栏都带 `min-height: 0`
       ⇒ 基准 = 0；容器高度是外部给定的定值，于是网格走的"Maximize Tracks"这一步
       把富余高度**均分**给两行（实测 535px 容器 ⇒ 每行恰好 259.64px），**不是**按内容定高。
       后果：每行都比自己的内容矮（左栏内容 416px），内容溢出自己的盒子，而后一栏按 DOM 顺序
       画在它上面 ⇒ 前栏的内容被盖住。`max-content` 让基准 = 增长上限 = 内容高度，
       没有可均分的富余，行高就等于内容。（`align-content: start` 挡不住均分 —— 那一步是
       "Maximize Tracks"，与 align-content 无关。） */
    grid-template-rows: max-content max-content;
    align-content: start;
    overflow: auto;
  }
  /* 堆叠形态下两栏必须**按内容定高**。
     ⚠️ 两个子栏的根元素都写着 `flex: 1`（并排形态下用来撑满各自那一列）—— 但 `flex: 1`
     的 flex-basis 是 **0**，于是在"高度由内容决定"的堆叠场景里，算出来的固有高度接近 0：
     格子跟着塌、栏内内容溢出自己的盒子，而后一栏按 DOM 顺序画在它上面 ⇒ 前栏的内容
     **被盖住**（实测：左栏空态的「导入 Excel / 新增产品」中心点 elementFromPoint 命中的是
     右栏 `.wb-metric` 里的 `<b>`）。
     并排形态不受影响（那里高度是外部给定的，`flex: 1` 正是要的效果），所以这条只写在窄形态里。 */
  .gd-wb__pane :deep(.gd-pane),
  .gd-wb__pane :deep(.gd-pool),
  /* 面板（`.wb-panel`）同理：它自己 `flex:1/min-height:180px`，内部 `.wb-panel__body` 又是
     `flex:1`（basis 0）—— 两层叠起来，面板的固有高度就只剩那个 180px 下限，而空态（图标 +
     标题 + 两行说明 + 两个按钮 ≈ 270px）装不下 ⇒ 表体自己滚，按钮被滚到可视区之外、
     落进下一栏的地盘里（实测 rect y=489，而左栏的盒子只到 ~441）。
     所以**这一层也要一起按内容定高**，并给表体一个上限：内容短就长到内容，长到超过 60vh
     才在自己内部滚 —— 这样"空态能完整看见"与"长列表不会把页面撑到几万像素"同时成立。 */
  .gd-wb__pane :deep(.gd-list),
  .gd-wb__pane :deep(.gd-panel) {
    flex: none;
  }
  .gd-wb__pane :deep(.wb-panel__body) {
    flex: none;
    max-height: 60vh;
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
