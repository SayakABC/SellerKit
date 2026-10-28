<script setup lang="ts">
// src/modules/order-cost/components/CostRatesSection.vue
// 「统计」页（2026-10-17 前叫「算钱」）的**数据基础**区（C9 收编，2026-09-30）：
// 产品当前进价（只读浏览）。
//
// 为什么整个区都是只读：**写入有唯一的家** —— 产品编辑抽屉（`ProductEditorDrawer`
// 的「进价（元）」栏）。这一页的定位是**算钱**：它回答"现在产品价里有什么、
// 为什么这行毛利是空的"。把录入放这里会让同一能力出现第二个平级入口（用户得猜哪个才是"真的"）。
//
// ⚠️ 这里列的是**产品当前价**（`pl_products.cost_cents`，给新订单钉预估用），
//    不是某一行的历史成本：订单行自己的两个快照（`cost_cents` 预估 / `actual_cost_cents` 实付）
//    才是利润的口径 —— 所以 "当前价" 与明细里某行的成本**本来就可能不一样**，不用说成同一份。
//
// 汇率维护入口已在 2026-10-22 随「基础数据 › 进价」页一起退役：当前全部订单金额均为人民币，
// `ae_rates` 仅剩迁移老采集库时读取，实时利润引擎不再依赖它（`orderCost.ts` 无汇率查询）。

import { onMounted, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import * as ipc from '@/core/services/ipc';
import type { ProductListItem } from '@/types';

const props = defineProps<{
  /** 有"缺成本"的行时自动展开（否则默认收起，不抢主视线的位置） */
  attention?: boolean;
  /** 父页刷新时一起重取（产品价可能刚被改） */
  refreshKey?: number;
}>();

const open = ref(false);
const loaded = ref(false);
const products = ref<ProductListItem[]>([]);
const productTotal = ref(0);
const loading = ref(false);
const search = ref('');

function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

function when(s: string): string {
  return s ? s.slice(0, 16).replace('T', ' ') : '—';
}

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    const p = await ipc.productList({ search: search.value.trim(), limit: 500 });
    if (p.success && p.data) {
      products.value = p.data.rows;
      productTotal.value = p.data.total;
    } else toast(`读取产品失败：${p.error ?? '未知错误'}`, 'error');
  } finally {
    loading.value = false;
    loaded.value = true;
  }
}

/** 展开（并按需首取）：把"用户看不到的东西"在需要它的那一刻递到眼前 */
function openNow(): void {
  open.value = true;
  if (!loaded.value) void refresh();
}

function toggle(): void {
  if (open.value) open.value = false;
  else openNow();
}

// 「缺成本」的行出现了就自动摊开（它就是这个区能补的东西）；消失后**不自动收起** ——
// 用户刚翻开正在看产品价时收起来，比多占一点高度更烦。
watch(
  () => props.attention,
  (v) => {
    if (v) openNow();
  }
);

// 已经展开过就跟着页面主刷新一起重取（产品价可能刚被改）
watch(
  () => props.refreshKey,
  () => {
    if (loaded.value) void refresh();
  }
);

// 搜索走后端（分页在服务端）：本地过滤只能筛到前 500 款，会把后面的款藏成"没有"
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(search, () => {
  if (!loaded.value) return;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void refresh(), 250);
});

onMounted(() => {
  if (props.attention) openNow();
});

defineExpose({ refresh });
</script>

<template>
  <section class="cr" data-act="cost-rates">
    <!-- 区头只有一颗「展开 / 收起」按钮。
         2026-10-22：原来右边还有一颗「去维护」跳「基础数据 › 进价」，随那一页整页退役一起撤掉 ——
         进价现在是产品行上的一列（产品编辑抽屉里的「进价（元）」栏），没有一个可跳的"成本页"；
         留一颗点下去空白页的按钮，比没有按钮更糟。 -->
    <div class="cr__head">
      <button class="cr__toggle" data-act="cr-toggle" @click="toggle">
        <span class="cr__title">数据基础：产品当前进价</span>
        <span class="cr__sum">
          产品 {{ productTotal }} 款
        </span>
        <span v-if="attention && !open" class="wb-tag is-warn cr__alert" data-act="cr-attention"
          >有行缺成本</span
        >
        <span class="cr__chev">{{ open ? '收起' : '展开' }}</span>
      </button>
    </div>

    <div v-if="open" class="cr__body">
      <div class="cr__block">
        <div class="cr__row">
          <span class="cr__label">产品当前进价（{{ productTotal }} 款）</span>
          <span class="cr__note">
            给新订单钉预估用的价；已经确认过的订单行用自己的快照，不跟着这里改。
            在产品编辑抽屉（基础数据 › 产品管理 › 编辑）的「进价（元）」栏维护
          </span>
          <input
            v-model="search"
            class="wb-input wb-input--sm cr__input cr__search"
            data-act="cost-search"
            placeholder="按款编码 / 款名过滤…"
          />
        </div>

        <table v-if="products.length" class="cr__table" data-act="cost-table">
          <thead>
            <tr>
              <th>款编码</th>
              <th>款名</th>
              <th class="cr__num">当前进价（元）</th>
              <th>厂家</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in products" :key="r.id">
              <td class="cr__mono">{{ r.code }}</td>
              <td :class="{ cr__muted: !r.name }">{{ r.name || '—' }}</td>
              <td class="cr__num" :class="{ cr__muted: !(r.costCents > 0) }">
                {{ r.costCents > 0 ? yuan(r.costCents) : '未填' }}
              </td>
              <td class="cr__muted">{{ r.supplierName || '—' }}</td>
              <td class="cr__muted">{{ when(r.updatedAt) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="cr__empty" data-act="cost-empty">
          {{ search.trim() ? '没有匹配的款 —— 换个关键字试试。' : '产品管理里还没有款 —— 去「基础数据 › 产品管理」建档，再在编辑抽屉里填进价。' }}
        </p>
      </div>

      <p v-if="loading" class="cr__loading">读取中…</p>
    </div>
  </section>
</template>

<style scoped>
.cr {
  border-top: 1px solid var(--wb-border);
  background: var(--wb-surface);
}
.cr__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--wb-border);
}
.cr__toggle {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--wb-text);
  cursor: pointer;
  text-align: left;
}
.cr__head:hover {
  background: var(--wb-hover);
}
.cr__title {
  font-size: 13px;
  font-weight: 600;
}
.cr__sum {
  font-size: 12px;
  color: var(--wb-text-muted);
}
/* 「有行缺成本」徽标：基座来自全局 .wb-tag.is-warn。
   原实现是 11px 字 + 999px 圆角（药丸），11px 已低于本项目的可读下限，且与相邻的
   .oc-tag/.pk-tag 造型不一致 —— 统一到同一档标签。 */
.cr__alert {
  flex-shrink: 0;
}
.cr__chev {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--wb-primary);
}
.cr__body {
  padding: 0 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.cr__block {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  padding: 12px;
}
.cr__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.cr__label {
  font-size: 13px;
  font-weight: 500;
}
.cr__note {
  font-size: 12px;
  color: var(--wb-text-muted);
}
.cr__search {
  margin-left: auto;
  width: 200px;
}
.cr__table {
  width: 100%;
  margin-top: 10px;
  border-collapse: collapse;
  font-size: 12px;
}
.cr__table th {
  text-align: left;
  font-weight: 400;
  color: var(--wb-text-muted);
  border-bottom: 1px solid var(--wb-border);
  padding: 6px 8px 6px 0;
}
.cr__table td {
  border-bottom: 1px solid var(--wb-border);
  padding: 6px 8px 6px 0;
}
.cr__table tr:last-child td {
  border-bottom: 0;
}
.cr__num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.cr__mono {
  font-family: var(--wb-font-mono, ui-monospace, monospace);
}
.cr__muted {
  color: var(--wb-text-muted);
}
.cr__empty {
  margin: 10px 0 0;
  padding: 12px 0;
  font-size: 12px;
  color: var(--wb-text-muted);
}
.cr__loading {
  margin: 0;
  font-size: 12px;
  color: var(--wb-text-muted);
}
</style>
