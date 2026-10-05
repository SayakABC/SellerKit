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
        <button class="wb-btn" data-act="refresh" :disabled="loading" @click="refresh">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </div>
    </header>

    <!-- 指标条：**只读事实**与**可去处理的待办**分开。
         左段（产品 / SKU）是规模事实，没有"点了去哪"的目的地，所以不做成按钮 ——
         原先它们和右边一样是可点的，但点下去都是 `goProducts('all')`（回到全部），
         看着能点、实际什么也不发生，属于假动作。
         右段每一项都能点：点了就切到对应页签并带上筛选，把"看到数字"和"去处理它"缝成一步。
         ⚠️ 每格必须是「标签 + 空格 + <b>数字</b>」同一串文本：goods:ui 冒烟按元素取 textContent
         断言 /产品 2/ 这类子串，拆成兄弟元素会拼成「产品2」而失配（见 docs/notes 的"铁律"）。 -->
    <div class="wb-metabar gd-stats" data-act="stats">
      <span class="wb-metric gd-metric gd-metric--fact">
        <span data-act="metric-products">产品 <b>{{ stats.products }}</b></span>
        <span class="gd-metric__sep" aria-hidden="true">·</span>
        <span data-act="metric-sku">SKU <b>{{ stats.variants }}</b></span>
      </span>
      <button
        class="wb-metric gd-metric"
        type="button"
        :class="{ 'is-warn': stats.missingWeight }"
        data-act="metric-missing"
        @click="goProducts('missingWeight')"
      >
        缺克重 <b>{{ stats.missingWeight }}</b>
      </button>
      <button
        class="wb-metric gd-metric"
        type="button"
        :class="{ 'is-warn': stats.noSupplier }"
        data-act="metric-no-supplier"
        @click="goProducts('noSupplier')"
      >
        未关联供应商 <b>{{ stats.noSupplier }}</b>
      </button>
      <button
        class="wb-metric gd-metric"
        type="button"
        data-act="metric-mapped"
        @click="goTab('mappings')"
      >
        已映射商品ID <b>{{ stats.mapped }}</b>
      </button>
    </div>

    <!-- 页签：徽标只放**待办**数（缺克重 / 待关联），不放总数 —— 放总数等于没有信息量 -->
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
        <span v-if="badgeOf(t.id)" class="gd-tab__badge" :class="{ 'is-warn': t.id !== 'suppliers' }">
          {{ badgeOf(t.id) }}
        </span>
      </button>
    </nav>

    <p v-if="error" class="wb-notice wb-notice--error gd-error">{{ error }}</p>

    <div class="gd-tabpanel">
      <ProductListView
        v-if="tab === 'products'"
        :intent="productIntent"
        @changed="void loadStats()"
        @suppliers-changed="void loadStats()"
      />
      <ShopProductView v-else-if="tab === 'shop-products'" @changed="void loadStats()" />
      <SkuMappingView v-else-if="tab === 'mappings'" @changed="onMappingChanged" />
      <SupplierView v-else @changed="void loadStats()" />
    </div>
  </div>
</template>

<script setup lang="ts">
// 「货与成本」外壳：页头 + 可点指标条 + 四页签。
//
// 这一页在 2026-10-01 之前是**薄内建**（只看产品/SKU/克重，重手段在「产品库」UI 岛）。
// 岛与宿主共用同一批数据、同一批 IPC，却因为"岛要单独发布 + 三个版本坐标要同步"而维护成本很高，
// 于是把岛的功能整体收回内建 —— 界面与交互按**单一工作台**重新组织（不再有"这功能在岛里"的心理负担）。
//
// 分工：
//   · 外壳（本文件）只负责**页签、页级指标、跨页签跳转**；
//   · 各页签自己取自己那份数据，改动后 emit('changed') 让外壳重算指标。
//   · 指标不在这里算第二遍，也不缓存到子视图 —— 只有一个数据源（`loadStats`）。
import { computed, onMounted, ref } from 'vue';
import * as api from './api';
import { toast } from '@/core/services/toast';
import ProductListView from './components/ProductListView.vue';
import ShopProductView from './components/ShopProductView.vue';
import SkuMappingView from './components/SkuMappingView.vue';
import SupplierView from './components/SupplierView.vue';

type TabId = 'products' | 'shop-products' | 'mappings' | 'suppliers';

const TABS: { id: TabId; label: string }[] = [
  { id: 'products', label: '产品' },
  { id: 'shop-products', label: '商品清单' },
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
  products: '自己的款和 SKU 在这里建档 —— 先有它，订单 / 采购 / 成本才挂得上这行货。',
  'shop-products': '从订单里认出来的店铺商品，看它们各自认到了哪个款、卖了多少行。',
  mappings: '把店铺商品认到自己的款上。左边是待办队列，右边是已经认完的。',
  suppliers: '拿货的供应商（厂）主数据 —— 产品建档与采购单据都引它。',
};

const loading = ref(false);
const error = ref('');
const tab = ref<TabId>('products');

const stats = ref({
  products: 0,
  variants: 0,
  missingWeight: 0,
  noSupplier: 0,
  mapped: 0,
  /** 待关联商品数（由「映射与关联」页算完回报 —— 它本来就要扫一次队列，别在这再扫一遍订单） */
  mappedQueue: 0,
});

/**
 * 给「产品」页签的筛选意图。
 * `nonce` 必须每次自增 —— 否则"连点两次同一个指标"只有第一次生效（watch 看不到变化）。
 */
const productIntent = ref<{ key: ProductIntentKey; nonce: number }>({
  key: 'all',
  nonce: 0,
});
type ProductIntentKey = 'all' | 'missingWeight' | 'noSupplier';

const badgeOf = (id: TabId): number => {
  if (id === 'products') return stats.value.missingWeight;
  if (id === 'mappings') return stats.value.mappedQueue;
  return 0;
};

function goTab(id: TabId): void {
  tab.value = id;
}

function goProducts(key: ProductIntentKey): void {
  productIntent.value = { key, nonce: productIntent.value.nonce + 1 };
  tab.value = 'products';
}

/**
 * 页级指标。
 * ⚠️ SKU / 缺克重必须把**每款的 SKU 都拉下来数**（`productSummary` 只给产品数与供应商分布）——
 *    列表一次拉到 500 上限，超过的部分数不到；这是个已知取舍：指标条用来"发现有没有问题"，
 *    真要数准得回产品页看总数。宁可少算也不假装算准。
 */
async function loadStats(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [listRes, skuSummary] = await Promise.all([
      api.list({ limit: 500, offset: 0, status: '', supplierId: 0, search: '' }),
      api.skuSummary().catch(() => null),
    ]);
    const products = listRes?.rows ?? [];

    let variants: { weightG: number }[] = [];
    if (products.length) {
      const vr = await api.variantList(products.map((p) => p.id));
      variants = vr?.rows ?? [];
    }

    stats.value = {
      products: listRes?.total ?? products.length,
      variants: variants.length,
      missingWeight: variants.filter((v) => !(Number(v.weightG) > 0)).length,
      noSupplier: products.filter((p) => !p.supplierId).length,
      mapped: skuSummary?.total ?? 0,
      // 待关联数由「映射与关联」页自己算并回报（它已经拉过队列，别在这再扫一次订单）
      mappedQueue: stats.value.mappedQueue,
    };
  } catch (e: unknown) {
    error.value = `读取失败：${e instanceof Error ? e.message : '未知错误'}`;
    toast(error.value, 'error');
  } finally {
    loading.value = false;
  }
}

function refresh(): void {
  void loadStats();
  productIntent.value = { key: productIntent.value.key, nonce: productIntent.value.nonce + 1 };
}

/**
 * 「映射与关联」页回报待关联数。
 * 队列是**实时聚合**订单算出来的，只有那一页拉得到 —— 外壳不重复扫一遍订单，
 * 而是拿它报上来的数字刷新页签徽标（这正是"只有一个数据源"的落地方式）。
 */
function onMappingChanged(payload?: { unmapped?: number }): void {
  if (typeof payload?.unmapped === 'number') {
    stats.value = { ...stats.value, mappedQueue: payload.unmapped };
  }
  void loadStats();
}

onMounted(async () => {
  // 建表必须在**任何读取之前**：`productList` 假定 `pl_products` 已存在。
  // 原岛把 ensure 放在各视图的 onMounted（Vue 子先于父），迁到内建后由外壳先 await 一次，
  // 子视图不再各自调（重复调虽然幂等，但会把"谁负责建表"这件事说糊）。
  try {
    await api.ensure();
  } catch (e: unknown) {
    error.value = `初始化失败：${e instanceof Error ? e.message : '未知错误'}`;
    return;
  }
  await loadStats();
});
</script>

<style scoped>
/* 页面外壳（内边距 / 栅格 / 滚动）由全局 .wb-page 提供。 */

/* 指标格由 <span> 变成 <button>（可点）—— 剥掉按钮默认外观，其余沿用 .wb-metric */
.gd-metric {
  border: 0;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s ease;
}
.gd-metric:hover {
  background: var(--wb-hover);
}

/* 只读事实格：不带 hover、不带指针 —— 它没有目的地，就不该长得像能点。
   （此前「产品 / SKU」两格是按钮，点了只是回到"全部"，属于假动作。） */
.gd-metric--fact {
  cursor: default;
  gap: 8px;
}
.gd-metric--fact:hover {
  background: transparent;
}
.gd-metric__sep {
  color: var(--wb-text-muted);
}

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
.gd-tab__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
}
.gd-tab__badge.is-warn {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
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
