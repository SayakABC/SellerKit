<script setup lang="ts">
// src/modules/shop-accounts/components/ShipRateOrdersTab.vue
// 「物流运费 › 按订单试算」（2026-10-15 由岛 dist/views/orders.js 迁入）。
// 订单（收货国家 + 款色码）× **产品库 SKU 克重** × 运价表 → 逐单实际运费。
//
// 本页**零算术**：试算由宿主 op 一手包办（取订单最小投影 → 提国家 → 联 SKU 克重 → 计价）。
// 拒算必须逐单给原因（缺重量 / 没国家 / 表没该国 / 无价 / 未接汇率），不静默丢行。
//
// ⚠️ 克重的唯一来源是**产品库 SKU 克重**（款 × 色 × 码，在「基础数据 › 货品档案」维护）——
//    2026-10-01 起「导入商品信息 Excel → 商品ID 克重」那条链已整条删除，本页只读、
//    没有也不该有导入按钮（见 shipRateStore / skuWeights 的注释）。
import { computed, ref } from 'vue';
import { useShipRateStore } from '../shipRateStore';
import { gramsText, money } from '../shipRateFormat';
import type { OrderQuoteRow } from '@/lib/shipRateOrders';

const store = useShipRateStore();

/** 结果表最多渲染的行数（其余折叠为"还有 N 条"，防止千行表格卡死） */
const MAX_RENDER_ROWS = 300;

/** 筛选词（模块级：切走再切回不丢，与岛时代 state('orders') 同语义） */
const filter = ref('');

const filteredRows = computed<OrderQuoteRow[]>(() => {
  const kw = filter.value.trim().toLowerCase();
  let rows = store.orderRows;
  if (kw) {
    rows = rows.filter(
      (r) =>
        String(r.orderNo || '').toLowerCase().includes(kw) ||
        String(r.countryRaw || '').toLowerCase().includes(kw) ||
        String(r.nameCn || '').toLowerCase().includes(kw) ||
        String(r.itemId || '').toLowerCase().includes(kw),
    );
  }
  return rows;
});

const hasRun = computed(() => store.orderRows.length > 0);

async function importTable(): Promise<void> {
  await store.importByDialog();
}
</script>

<template>
  <div class="sro">
    <!-- 克重来源说明（**没有导入按钮**：克重属 SKU，在「货品档案」维护） -->
    <section class="wb-panel">
      <div class="wb-panel__head"><span>克重从哪来</span></div>
      <div class="wb-panel__body">
        <p class="wb-muted sro__note">
          每件货的克重取<b>产品库的 SKU 克重</b>（款 × 色 × 码，同一款不同颜色/尺码可以不同）—— 在「基础数据 › 产品管理」里维护，本页只读。没维护的 SKU
          会在下方逐单标「缺重量」。
        </p>
      </div>
    </section>

    <section class="wb-panel">
      <template v-if="!store.hasTable">
        <div class="wb-panel__body">
          <div class="wb-empty" data-act="ship-empty">
            <div class="sro__empty-title">还没有运价表</div>
            <p class="wb-muted">先在「运费查询」页导入物流报价单 Excel，再来按订单试算。</p>
            <button class="wb-btn wb-btn--primary" type="button" data-act="ship-import" @click="importTable">
              导入运价表
            </button>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="wb-panel__head">
          <span>按订单试算</span>
          <span class="wb-muted">逐单取「收货国家 + 款色码」，联产品库 SKU 克重后按运价表计价；数量暂按 1 件/单计</span>
        </div>
        <div class="wb-panel__body sro__bar">
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            data-act="ship-orders-run"
            :disabled="store.busyOrders"
            @click="store.runQuoteOrders()"
          >
            {{ store.busyOrders ? '试算中…' : '试算最近 500 单' }}
          </button>
          <label class="wb-field sro__grow">
            <span class="wb-field__label">筛选</span>
            <input
              class="wb-input"
              data-act="ship-orders-filter"
              type="search"
              placeholder="订单号 / 国家 / 商品ID"
              :value="filter"
              @input="filter = ($event.target as HTMLInputElement).value"
            />
          </label>
        </div>

        <div class="wb-panel__body" data-act="ship-order-results">
          <div v-if="store.orderSummary" class="sro__summary">
            <span class="wb-tag">共 <b>{{ store.orderSummary.total }}</b> 单</span>
            <span class="wb-tag is-on">有价 <b>{{ store.orderSummary.ok }}</b></span>
            <span v-if="store.orderSummary.noWeight" class="wb-tag is-warn">缺重量 <b>{{ store.orderSummary.noWeight }}</b></span>
            <span v-if="store.orderSummary.noCountry" class="wb-tag is-warn">无国家 <b>{{ store.orderSummary.noCountry }}</b></span>
            <span v-if="store.orderSummary.unknownCountry" class="wb-tag is-warn">表没该国 <b>{{ store.orderSummary.unknownCountry }}</b></span>
            <span v-if="store.orderSummary.noPrice" class="wb-tag is-warn">该克重无价 <b>{{ store.orderSummary.noPrice }}</b></span>
            <span v-if="store.orderSummary.refused" class="wb-tag is-warn">未接汇率 <b>{{ store.orderSummary.refused }}</b></span>
            <span v-if="store.busyOrders" class="wb-muted">计算中…</span>
          </div>

          <div v-if="!filteredRows.length" class="wb-empty sro__empty-sm">
            {{ hasRun ? '没有匹配的订单' : '点上方按钮开始试算' }}
          </div>

          <template v-else>
            <div class="wb-table-wrap">
              <table class="wb-table" data-act="ship-order-table">
                <thead>
                  <tr>
                    <th class="wb-num">#</th>
                    <th>订单号</th>
                    <th>国家/地区</th>
                    <th>商品ID</th>
                    <th>重量</th>
                    <th>Code</th>
                    <th>运费(元) / 原因</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in filteredRows.slice(0, MAX_RENDER_ROWS)" :key="`${r.id}-${i}`" :class="{ 'sro__row-fail': !r.ok }">
                    <td class="wb-num">{{ i + 1 }}</td>
                    <td class="wb-mono sro__nowrap">{{ r.orderNo || '—' }}</td>
                    <td class="sro__nowrap">
                      {{ r.ok ? r.nameCn : r.countryRaw || '—'
                      }}<span v-if="r.ok && r.countryRaw && r.countryRaw !== r.nameCn" class="wb-tag">{{ r.countryRaw }}</span>
                    </td>
                    <td class="wb-mono sro__nowrap">{{ r.itemId || '—' }}</td>
                    <td class="wb-muted sro__nowrap">{{ r.weightG > 0 ? gramsText(r.weightG) : '—' }}</td>
                    <td class="wb-muted wb-mono sro__nowrap">{{ r.ok ? r.code : '—' }}</td>
                    <td v-if="r.ok" class="wb-num sro__strong">{{ money(r.fee) }}</td>
                    <td v-else class="wb-muted">{{ r.reason }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="filteredRows.length > MAX_RENDER_ROWS" class="wb-muted sro__more">
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
.sro {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
.sro__note {
  font-size: 12.5px;
  line-height: 1.7;
  margin: 0;
}
.sro__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px 14px;
}
.sro__grow {
  flex: 1 1 200px;
  min-width: 180px;
}
.sro__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.sro__empty-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 6px;
}
.sro__empty-sm {
  padding: 18px 0;
  font-size: 12.5px;
}
.sro__row-fail td {
  color: var(--wb-text-muted);
}
.sro__strong {
  font-weight: 600;
}
.sro__more {
  margin-top: 8px;
  font-size: 12px;
}
.sro__nowrap {
  white-space: nowrap;
}
</style>
