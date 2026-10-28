<script setup lang="ts">
// src/modules/shop-accounts/components/ShipRateProductsTab.vue
// 「物流运费 › 按产品试算」（2026-10-15 由岛 dist/views/products.js 迁入）。
// 产品库（款编码 + SKU 克重）× 选定目的国 → 逐 SKU 实际运费。
//
// 重量锚点是产品库 SKU 子表（编辑产品时维护的克重）——「按订单试算」读的是**同一份**克重：
// 订单页回答"这些已成交的订单运费多少"，本页回答"我的产品发到某国每件运费多少"。
// 拒算必须逐行给原因（未维护克重 / 无价 / 未接汇率），不静默丢行。
import { computed, ref } from 'vue';
import { useShipRateStore } from '../shipRateStore';
import { gramsText, money } from '../shipRateFormat';
import type { ProductQuoteRow } from '@/lib/shipRateProducts';

const store = useShipRateStore();

/** 结果表最多渲染的行数（其余折叠为"还有 N 条"，防止千行表格卡死） */
const MAX_RENDER_ROWS = 300;

/** 筛选词（模块级：切走再切回不丢，与岛时代 state('products') 同语义） */
const filter = ref('');

const filteredRows = computed<ProductQuoteRow[]>(() => {
  const kw = filter.value.trim().toLowerCase();
  let rows = store.productRows;
  if (kw) {
    rows = rows.filter(
      (r) =>
        String(r.code || '').toLowerCase().includes(kw) ||
        String(r.name || '').toLowerCase().includes(kw) ||
        String(r.skuLabel || '').toLowerCase().includes(kw),
    );
  }
  return rows;
});

const hasRun = computed(() => store.productRows.length > 0);

/** 目的国下拉：默认选中上次用过的国（无记录则选第一项，不静默提交） */
function onCountryChange(v: string): void {
  store.setProductCountry(v);
}

async function importTable(): Promise<void> {
  await store.importByDialog();
}
</script>

<template>
  <div class="srp2">
    <section class="wb-panel">
      <template v-if="!store.hasTable">
        <div class="wb-panel__body">
          <div class="wb-empty" data-act="ship-empty">
            <div class="srp2__empty-title">还没有运价表</div>
            <p class="wb-muted">先在「运费查询」页导入物流报价单 Excel，再来按产品试算。</p>
            <button class="wb-btn wb-btn--primary" type="button" data-act="ship-import" @click="importTable">
              导入运价表
            </button>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="wb-panel__head">
          <span>按产品试算</span>
          <span class="wb-muted">重量取产品库 SKU 克重（编辑产品时维护）；每个 SKU 一行，数量按 1 件/件计</span>
        </div>
        <div class="wb-panel__body srp2__bar">
          <label class="wb-field">
            <span class="wb-field__label">目的国/地区</span>
            <select
              class="wb-input"
              data-act="ship-country"
              :value="store.productCountry || (store.countriesSorted[0] && store.countriesSorted[0].nameCn) || ''"
              @change="onCountryChange(($event.target as HTMLSelectElement).value)"
            >
              <option v-if="!store.countriesSorted.length" value="">（运价表没有国家）</option>
              <option v-for="c in store.countriesSorted" :key="c.nameCn" :value="c.nameCn">
                {{ c.nameCn }}（{{ c.code }}）
              </option>
            </select>
          </label>
          <label class="wb-field srp2__grow">
            <span class="wb-field__label">筛选</span>
            <input
              class="wb-input"
              data-act="ship-products-filter"
              type="search"
              placeholder="款编码 / 名称 / SKU"
              :value="filter"
              @input="filter = ($event.target as HTMLInputElement).value"
            />
          </label>
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            data-act="ship-products-run"
            :disabled="store.busyProducts"
            @click="store.runQuoteProducts()"
          >
            {{ store.busyProducts ? '试算中…' : '试算全部产品' }}
          </button>
        </div>
        <div class="wb-panel__body">
          <p class="wb-muted srp2__hint">
            未维护克重的 SKU 会单独成行提示（去「产品管理」的「款与商品」补克重）；计算口径与「运费查询」页共用（普货/非普/大包 · 取整方式）。
          </p>
        </div>

        <div class="wb-panel__body" data-act="ship-product-results">
          <div v-if="store.productSummary" class="srp2__summary">
            <span class="wb-tag">共 <b>{{ store.productSummary.total }}</b> 个 SKU</span>
            <span class="wb-tag is-on">有价 <b>{{ store.productSummary.ok }}</b></span>
            <span v-if="store.productSummary.noWeight" class="wb-tag is-warn">缺克重 <b>{{ store.productSummary.noWeight }}</b></span>
            <span v-if="store.productSummary.unknownCountry" class="wb-tag is-warn">表没该国 <b>{{ store.productSummary.unknownCountry }}</b></span>
            <span v-if="store.productSummary.noPrice" class="wb-tag is-warn">该克重无价 <b>{{ store.productSummary.noPrice }}</b></span>
            <span v-if="store.productSummary.refused" class="wb-tag is-warn">未接汇率 <b>{{ store.productSummary.refused }}</b></span>
            <span v-if="store.busyProducts" class="wb-muted">计算中…</span>
          </div>

          <div v-if="!filteredRows.length" class="wb-empty srp2__empty-sm">
            {{ hasRun ? '没有匹配的产品' : '选好目的国后点「试算全部产品」' }}
          </div>

          <template v-else>
            <div class="wb-table-wrap">
              <table class="wb-table" data-act="ship-product-table">
                <thead>
                  <tr>
                    <th class="wb-num">#</th>
                    <th>款编码</th>
                    <th>名称</th>
                    <th>SKU</th>
                    <th>克重</th>
                    <th>运费(元) / 原因</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in filteredRows.slice(0, MAX_RENDER_ROWS)" :key="`${r.productId}-${r.skuLabel}-${i}`" :class="{ 'srp2__row-fail': !r.ok }">
                    <td class="wb-num">{{ i + 1 }}</td>
                    <td class="wb-mono">{{ r.code || '—' }}</td>
                    <td>{{ r.name || '—' }}</td>
                    <td class="wb-muted srp2__nowrap">{{ r.skuLabel || '—' }}</td>
                    <td class="wb-muted srp2__nowrap">{{ r.weightG > 0 ? gramsText(r.weightG) : '—' }}</td>
                    <td v-if="r.ok" class="wb-num srp2__strong">{{ money(r.fee) }}</td>
                    <td v-else class="wb-muted">{{ r.reason }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="filteredRows.length > MAX_RENDER_ROWS" class="wb-muted srp2__more">
              只渲染前 {{ MAX_RENDER_ROWS }} 条，共 {{ filteredRows.length }} 条匹配（可用筛选缩小范围）。
            </p>
          </template>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* 高度链见 ShipRateQuoteTab.vue 的 style 头注：`flex:1` 只在祖先给出确定高度时
   才是"伸缩"，否则会把内容平分。四个页签同此契约（2026-10-15 一起修）。 */
.srp2 {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
.srp2__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px 14px;
}
.srp2__grow {
  flex: 1 1 200px;
  min-width: 180px;
}
.srp2__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.srp2__hint {
  margin: 0;
  font-size: 12.5px;
}
.srp2__empty-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 6px;
}
.srp2__empty-sm {
  padding: 18px 0;
  font-size: 12.5px;
}
.srp2__row-fail td {
  color: var(--wb-text-muted);
}
.srp2__strong {
  font-weight: 600;
}
.srp2__nowrap {
  white-space: nowrap;
}
.srp2__more {
  margin-top: 8px;
  font-size: 12px;
}
</style>
