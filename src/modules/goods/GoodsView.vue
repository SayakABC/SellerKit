<template>
  <div class="wb-page gd-view">
    <header class="wb-head">
      <div class="wb-head__main">
        <h1 class="wb-head__title">货与成本</h1>
        <!-- 说明随页签走：一句话回答"这页是干什么的、我什么时候该来这"。
             比原来那句固定枚举（"款式 · SKU · 克重 · 厂家 · 商品ID 映射"）有用 —— 那句话
             在切了页签之后就不成立了，而用户切页签时正是最需要一句解释的时刻。 -->
        <p class="wb-head__desc">{{ TAB_DESC[tab] }}</p>
      </div>
      <div class="wb-head__actions">
        <!-- 页级不再自己取数，所以这里没有"读取中…"可报（那是各视图自己的状态，
             它们在各自的工具栏里显示）。按钮只负责发一个刷新信号。 -->
        <button class="wb-btn" data-act="refresh" @click="refresh">刷新</button>
      </div>
    </header>

    <!-- 页签：紧贴主体 —— 页面顶部只剩「页头 + 页签」两层。
         ⚠️ 这里原先还有一条**指标条**（产品 / SKU / 缺克重 / 未关联供应商 / 已映射商品ID）
         与一条**起点引导条**（立款 → 补克重 → 认货），2026-10-08 按用户要求整块撤掉：
           · 指标条那五个数字，左栏每一行本来就带着（`n · 缺 m`、状态列），单独再汇总一行是重复；
           · 引导条的三步，点一遍页签就知道顺序，常驻一条占着一行高度没有换来新的信息。
         配套改动：页签上的**数字徽标**一并去掉（徽标与被撤的指标条同源，留着就要保留整套页级
         汇总取数）；「缺克重 / 未关联供应商」这两个筛选的入口搬进了左栏工具栏（`filter-issue`）。

         ⚠️ 同日 S4：`'workbench'` 形态下**页签由 3 个收成 2 个** ——「产品」与「映射与关联」
         合并为「建档与关联」（`data-act="tab-workbench"`）。页签表按形态分叉，理由见 `TABS` 上方的注释。 -->
    <nav class="gd-tabs" role="tablist" aria-label="货与成本">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        class="gd-tab"
        :class="{ 'is-active': tab === t.id }"
        :aria-selected="tab === t.id"
        :data-act="`tab-${t.id}`"
        @click="goTab(t.id)"
      >
        {{ t.label }}
      </button>
    </nav>

    <p v-if="error" class="wb-notice wb-notice--error gd-error">{{ error }}</p>

    <div class="gd-tabpanel">
      <!-- 工作台形态（S0 骨架 → S4 定型）：左「产品」右「商品池」**恒同屏**。
           S4 把「产品」与「映射与关联」合成一个页签后，池栏不再有"当前看不见"的时候 ——
           于是 `pool` 这个懒挂载开关也一并撤掉（它的唯一理由是"首屏停在产品页签、池栏看不见"，
           合并后该前提消失）。判据与代价见 `GoodsWorkbenchView.vue` 顶部注释。 -->
      <GoodsWorkbenchView
        v-if="GOODS_LAYOUT === 'workbench' && tab === 'workbench'"
        :refresh-nonce="refreshNonce"
      />
      <SupplierView v-else-if="tab === 'suppliers'" />
      <!-- 「商品清单」页签当前**收起**（见 `SHOP_PRODUCTS_TAB_ENABLED`）：分支与组件保留在这里，
           是为了要放回来时只改那一个常量。`tab` 永远取不到这个值，所以这段是不渲染的死代码 ——
           别当成"多余的 else-if"清掉，那是恢复开关的另一半。 -->
      <ShopProductView v-else-if="tab === 'shop-products'" />
      <!-- 以下两支是 `GOODS_LAYOUT === 'tabs'` 的**回退路径**（与重构前逐字一致），不是死代码。 -->
      <ProductListView v-else-if="tab === 'products'" :refresh-nonce="refreshNonce" />
      <SkuMappingView v-else />
    </div>
  </div>
</template>

<script setup lang="ts">
// 「货与成本」外壳：页头 + 三页签（「商品清单」已收起）。
//
// 这一页在 2026-10-01 之前是**薄内建**（只看产品/SKU/克重，重手段在「产品库」UI 岛）。
// 岛与宿主共用同一批数据、同一批 IPC，却因为"岛要单独发布 + 三个版本坐标要同步"而维护成本很高，
// 于是把岛的功能整体收回内建 —— 界面与交互按**单一工作台**重新组织（不再有"这功能在岛里"的心理负担）。
//
// 分工：
//   · 外壳（本文件）只负责**页头、页签、跨页签跳转**；
//   · 各页签自己取自己那份数据，外壳**不再**汇总任何页级数字。
//
// ⚠️ 2026-10-08 撤掉了两层页级 UI（指标条 + 起点引导条）和页签徽标（见模板中间那段注释）。
//    连带把 `stats` / `loadStats` / `flow.ts` / 子视图→外壳的回报链整条移除：它们唯一的消费者
//    就是那两层，留着只会是"每次刷新都多打几次 IPC、却没有任何人看"的页级空转。
import { onMounted, ref } from 'vue';
import * as api from './api';
import ProductListView from './components/ProductListView.vue';
import GoodsWorkbenchView from './components/GoodsWorkbenchView.vue';
import ShopProductView from './components/ShopProductView.vue';
import SkuMappingView from './components/SkuMappingView.vue';
import SupplierView from './components/SupplierView.vue';

type TabId = 'workbench' | 'products' | 'shop-products' | 'mappings' | 'suppliers';

/**
 * 「商品清单」页签**暂时收起**（2026-10-08）。
 *
 * 判据是"有没有下游消费者"（同 `docs/notes/2026-10-01-ui-island-retirement` 的域删除判据）：
 * 这一页签的产出是 `pl_shop_sku` 的**池行**（`source='shop-import'` / `shop_id=0`），
 * 而订单归款 / 拣货 / 算钱一律走它的**补集** `skuMappingSql()` —— `skuPoolSql()` 全仓只有
 * `electron/shop-product-db.ts` 自己用。也就是：用户在这里导入商品、关联产品之后，
 * **其它任何页面都不会变**。
 *
 * 它还额外要求一份**独立准备**的 Excel（列名须为「产品ID」「产品图片链接」），而用户真正想要的
 * "导入后看看到底进来了哪些数据"由「映射与关联」的待关联队列（从订单实时聚出）与「今天」页的
 * 导入回执覆盖了。留着它只会让人以为"少做了这一步所以后面算不出来"。
 *
 * **只收界面，不动数据**：`ShopProductView.vue`、`shop-product-*` 6 个 IPC 通道、`shop-product-db.ts`
 * 与存量池行全部原样保留。要放回来 = 把本常量改成 `true`（TABS 恢复四项），其余一行不用改。
 * 反向守卫在 `scripts/goods-ui-smoke.mjs`（断言页签**没有**它），防止它以"补个入口吧"的名义回来。
 */
const SHOP_PRODUCTS_TAB_ENABLED = false;

/**
 * 页面形态开关（2026-10-08，重构 S0）。
 *
 * `'workbench'` = 左右分栏工作台：左栏「产品」、右栏「商品池」，两栏同屏
 *   （方案见 `docs/plans/GOODS_WORKBENCH_PLAN.md`）。
 * `'tabs'`      = 回到旧的三页签形态（产品 / 映射与关联 / 供应商 各自独占整宽）。
 *
 * **回退 = 改这一个常量**（同 `SHOP_PRODUCTS_TAB_ENABLED` 的先例）：旧组件一个都不删，
 * `'tabs'` 分支保留的是**今天这套一模一样的 DOM**。分阶段上线期间，任何一步出问题都可以
 * 一行改成 `'tabs'` 退回原状，不用回滚代码。
 *
 * ⚠️ `'tabs'` 之外的那套 DOM 不是"死代码"，别当多余的 else 分支删掉 —— 它是回退路径的另一半。
 */
const GOODS_LAYOUT: 'workbench' | 'tabs' = 'workbench';

/**
 * 页签表（2026-10-08 重构 S4：3 → 2）。
 *
 * **按页面形态分叉** —— 不是两套界面各自任性，而是两种形态的导航结构本就不同：
 *   · `'workbench'` 把「产品」与「映射与关联」**合并成一个左右分栏的工作台**。合并的判据不是
 *     "少一个页签更清爽"，而是：分栏的全部价值在于**同屏**（左栏看着款、右栏认着货，
 *     左栏选一款右栏就能直连、就能对比）—— 分成两个页签，两侧永远不可能同时出现在屏幕上，
 *     直连与对比这两条动线在物理上就不成立。
 *   · `'tabs'` 回退形态是整宽单栏，产品表与队列必须各自独占一屏 ⇒ **仍是三个页签**。
 *     回退时页签跟着一起回去，否则"改一个常量回退"就是假的（会退到一个只剩两个页签、
 *     却仍然单栏渲染的表上）。
 *
 * ⚠️ `'workbench'` 那一支里没有「商品清单」：该页签的产出（`pl_shop_sku` 的池行）
 *    没有下游消费方，`SHOP_PRODUCTS_TAB_ENABLED` 的判据见下。
 */
const TABS: { id: TabId; label: string }[] =
  GOODS_LAYOUT === 'workbench'
    ? [
        { id: 'workbench', label: '建档与关联' },
        { id: 'suppliers', label: '供应商' },
      ]
    : [
        { id: 'products', label: '产品' },
        ...(SHOP_PRODUCTS_TAB_ENABLED
          ? [{ id: 'shop-products' as TabId, label: '商品清单' }]
          : []),
        { id: 'mappings', label: '映射与关联' },
        { id: 'suppliers', label: '供应商' },
      ];

/**
 * 页头说明：**随页签走**的一句话。
 * 页签名是导航用的短标签（要短、要能并排），没法承担解释职责；而"切过去以后不知道这页干嘛"
 * 是这一页最常见的一句话反馈。这里用页头那行**本来就有**的说明位补上，不新增任何控件。
 * 写法要求：一句人话 + 什么时候该来这（先有它 / 待办在左边 / 做完的在右边）。
 */
const TAB_DESC: Record<TabId, string> = {
  // 合并后的说明 = 原「产品」+「映射与关联」两句的**一句话版**：左边建档、右边认货，
  // 并且点出分栏独有的那一步（左栏选一款 → 右栏直接关联过去），否则用户不会知道两栏是联动的。
  workbench: '左边给自己的款和 SKU 建档，右边把店铺商品认到款上 —— 左栏选一款，右栏就能直接关联过去。',
  products: '自己的款和 SKU 在这里建档 —— 先有它，订单 / 采购 / 成本才挂得上这行货。',
  'shop-products': '从订单里认出来的店铺商品，看它们各自认到了哪个款、卖了多少行。',
  mappings: '把店铺商品认到自己的款上。左边是待办队列，右边是已经认完的。',
  suppliers: '拿货的供应商（厂）主数据 —— 产品建档与采购单据都引它。',
};

const error = ref('');
// 默认页签跟着形态走：工作台形态下 `'products'` 这个值根本不在 TABS 里（渲染出来会是
// 一个高亮不上的页签 + 走 `v-else` 兜底渲染错组件），必须用两侧都存在的那一个。
const tab = ref<TabId>(GOODS_LAYOUT === 'workbench' ? 'workbench' : 'products');

/**
 * 页级「刷新」按钮的信号（自增 nonce，用法见下方 `refresh()`）。
 */
const refreshNonce = ref(0);

function goTab(id: TabId): void {
  tab.value = id;
}

/**
 * 页级「刷新」。
 *
 * 外壳自己**不再取任何数**（指标条撤了），所以它只能"戳一下"当前挂着的那个视图：
 * 值一变，左栏（或 `'tabs'` 回退形态的产品列表）就把自己那份数据重拉一遍。
 * 用自增的 nonce 而不是布尔 —— 连点两次也要各生效一次（布尔第二次看不到变化）。
 */
function refresh(): void {
  refreshNonce.value += 1;
}

onMounted(async () => {
  // 建表必须在**任何读取之前**：`productList` 假定 `pl_products` 已存在。
  // 原岛把 ensure 放在各视图的 onMounted（Vue 子先于父），迁到内建后由外壳先 await 一次，
  // 子视图不再各自调（重复调虽然幂等，但会把"谁负责建表"这件事说糊）。
  try {
    await api.ensure();
  } catch (e: unknown) {
    error.value = `初始化失败：${e instanceof Error ? e.message : '未知错误'}`;
  }
});
</script>

<style scoped>
/* 页面外壳（内边距 / 栅格 / 滚动）由全局 .wb-page 提供。 */

/* 页签：紧贴主体（`margin-bottom` 的负值把下面那层间隙吃掉）。 */
.gd-tabs {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  margin-bottom: -16px; /* 贴住下方内容，省掉一层间隙 */
  border-bottom: 1px solid var(--wb-border);
}
.gd-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.gd-tab:hover {
  color: var(--wb-text);
}
.gd-tab.is-active {
  color: var(--wb-text);
  font-weight: 600;
  border-bottom-color: var(--wb-primary);
}

/* 页签面板：撑满剩余高度，内部各自滚动 */
.gd-tabpanel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.gd-error {
  margin: 0;
}
</style>
