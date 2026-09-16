<script setup lang="ts">
// extensions/ae-profit/src/components/OrderListPanel.vue
// 订单明细（M0 迁移）：分币种收支汇总 + 订单明细列表（搜索/分页）。
// 依赖主进程 ae_orders / ae_order_lines / ae_order_fees 只读查询 IPC。

import { computed, onMounted, ref, watch } from 'vue';
import { aeOrderList, aeSummary } from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import { fmtMoney, fmtTime, feeLabel } from '../format';
import type { AeFeeItem, AeOrderListItem, AeSummary } from '@/types';

const props = defineProps<{ refreshKey: number }>();

const PAGE_SIZE = 50;

const rows = ref<AeOrderListItem[]>([]);
const total = ref(0);
const page = ref(1);
const search = ref('');
const summary = ref<AeSummary | null>(null);
const loading = ref(false);

const totalPage = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const hasData = computed(() => rows.value.length > 0);

function feeText(fees?: AeFeeItem[]): string {
  if (!fees || !fees.length) return '—';
  return fees.map((f) => `${feeLabel(f.category)} ${fmtMoney(f.amount)}`).join(' · ');
}
/** 单订单费用合计（订单内费用同币种，可直接相加） */
function feeTotal(fees?: AeFeeItem[]): string {
  if (!fees || !fees.length) return '—';
  return fmtMoney(fees.reduce((s, f) => s + (Number.isFinite(f.amount) ? f.amount : 0), 0));
}

async function loadSummary(): Promise<void> {
  const r = await aeSummary();
  if (r.success && r.data !== undefined) summary.value = r.data;
}

async function loadList(): Promise<void> {
  const r = await aeOrderList({ offset: (page.value - 1) * PAGE_SIZE, limit: PAGE_SIZE, search: search.value });
  if (r.success && r.data !== undefined) {
    rows.value = r.data.rows;
    total.value = r.data.total;
  } else if (r.success) {
    rows.value = [];
    total.value = 0;
  } else {
    toast.error(`加载订单失败：${r.error ?? '未知错误'}`);
  }
}

async function reload(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    await Promise.all([loadSummary(), loadList()]);
  } finally {
    loading.value = false;
  }
}

function onSearch(): void {
  page.value = 1;
  void loadList();
}
function prevPage(): void {
  if (page.value > 1) {
    page.value -= 1;
    void loadList();
  }
}
function nextPage(): void {
  if (page.value < totalPage.value) {
    page.value += 1;
    void loadList();
  }
}

watch(() => props.refreshKey, () => void reload());
onMounted(() => void reload());
</script>

<template>
  <div class="ae-order">
    <div v-if="summary" class="summary-grid">
      <div class="sum-card main">
        <div class="sum-label">累计订单</div>
        <div class="sum-value">{{ summary.totalOrders }}</div>
        <div class="sum-sub">
          Σ 商品金额 {{ fmtMoney(summary.totalGoodsAmount) }} · 买家运费 {{ fmtMoney(summary.totalShippingIncome) }}
          <span class="dim-note">（跨币种预览，真实口径看分币种）</span>
        </div>
      </div>
      <div class="sum-card">
        <div class="sum-label">分币种收支</div>
        <table v-if="summary.byCurrency.length" class="mini-table">
          <thead>
            <tr>
              <th>币种</th>
              <th class="num">单数</th>
              <th class="num">商品金额</th>
              <th class="num">买家运费</th>
              <th>费用科目</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in summary.byCurrency" :key="g.currency">
              <td>{{ g.currency }}</td>
              <td class="num">{{ g.orders }}</td>
              <td class="num">{{ fmtMoney(g.goodsAmount) }}</td>
              <td class="num">{{ fmtMoney(g.shippingIncome) }}</td>
              <td>
                <span v-for="f in g.fees" :key="f.category" class="fee-chip">{{ feeLabel(f.category) }} {{ fmtMoney(f.total) }}</span>
                <span v-if="!g.fees.length" class="dim-note">—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-hint">暂无数据</div>
      </div>
      <div class="sum-card">
        <div class="sum-label">口径说明</div>
        <div class="scope-note">
          收入侧：商品金额 + 买家运费；费用侧：订单级 <span class="mono-sm">fees</span> 科目（平台佣金 / 物流费(卖) / 支付通道费 / 退款·纠纷），
          分币种聚合，M1 利润引擎在此口径上计算净额。
        </div>
        <div class="scope-note dim-note">费用科目化存储：新增科目 = 采集端多推一条 fees 条目，主程序与表结构零改动；未知科目宽容入库。</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="search-box">
          <input v-model="search" placeholder="按订单号 / 店铺名搜索" @keyup.enter="onSearch" />
          <button class="ghost-btn small" @click="onSearch">搜索</button>
        </div>
        <span class="total-hint">共 {{ total }} 单</span>
      </div>

      <div v-if="hasData" class="table-scroll">
        <table class="order-table">
          <thead>
            <tr>
              <th>订单号</th>
            <th>下单时间</th>
            <th>状态</th>
            <th>币种</th>
            <th class="num">商品金额</th>
            <th class="num">买家运费</th>
            <th>费用明细</th>
            <th class="num">费用Σ</th>
            <th class="num">SKU</th>
            <th>更新时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td class="mono">{{ row.orderId }}</td>
            <td>{{ fmtTime(row.orderTime) }}</td>
            <td>{{ row.status || '—' }}</td>
            <td>{{ row.currency }}</td>
            <td class="num">{{ fmtMoney(row.goodsAmount) }}</td>
            <td class="num">{{ fmtMoney(row.shippingIncome) }}</td>
            <td class="fee-detail" :title="feeText(row.fees)">{{ feeText(row.fees) }}</td>
            <td class="num">{{ feeTotal(row.fees) }}</td>
            <td class="num">{{ row.lineCount }}</td>
            <td class="dim">{{ fmtTime(row.updatedAt) }}</td>
          </tr>
        </tbody>
      </table>
      </div>

      <div v-else class="empty-state">
        <p v-if="!loading">还没有订单数据。</p>
        <p class="empty-hint">方式一：安装 Chrome 扩展，在速卖通卖家后台订单列表页采集（见 SellerKitExtensions 仓库 README）；</p>
        <p class="empty-hint">方式二：点右上角「复制 curl 样例」，在本机终端运行即可看到示例订单入库。</p>
      </div>

      <div class="pager">
        <button class="ghost-btn small" :disabled="page <= 1" @click="prevPage">上一页</button>
        <span class="page-hint">{{ page }} / {{ totalPage }}</span>
        <button class="ghost-btn small" :disabled="page >= totalPage" @click="nextPage">下一页</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ae-order {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
}
.sum-card {
  min-width: 0;
  overflow-x: auto;
  border: 1px solid var(--wb-border);
  background: var(--wb-surface);
  border-radius: 10px;
  padding: 12px 14px;
}
.sum-card.main .sum-value {
  font-size: 28px;
  font-weight: 700;
  margin-top: 4px;
}
.sum-label {
  font-size: 12px;
  color: var(--wb-text-muted);
  margin-bottom: 6px;
}
.mini-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  white-space: nowrap;
}
.mini-table th {
  text-align: left;
  font-weight: 500;
  color: var(--wb-text-muted);
  padding: 0 4px 4px 0;
}
.mini-table th.num {
  text-align: right;
}
.mini-table td {
  padding: 2px 0;
  vertical-align: top;
}
.mini-table td.num {
  text-align: right;
}
.fee-chip {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--wb-primary-soft, rgba(99, 102, 241, 0.12));
  color: var(--wb-primary, #6366f1);
  white-space: nowrap;
}
.sum-sub {
  font-size: 12px;
  color: var(--wb-text-muted);
  margin-top: 8px;
}
.dim-note {
  color: var(--wb-text-muted);
  font-size: 11px;
}
.mono-sm {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
.scope-note {
  font-size: 12px;
  line-height: 1.7;
  margin: 4px 0;
}
.panel {
  border: 1px solid var(--wb-border);
  background: var(--wb-surface);
  border-radius: 10px;
  padding: 12px;
  overflow: hidden;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
}
.search-box input {
  width: 260px;
}
.total-hint,
.page-hint {
  font-size: 12px;
  color: var(--wb-text-muted);
}
.table-scroll {
  overflow-x: auto;
}
.order-table {
  width: 100%;
  min-width: 1040px;
  border-collapse: collapse;
  font-size: 13px;
}
.order-table th,
.order-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--wb-border);
  white-space: nowrap;
}
.order-table th {
  font-size: 12px;
  color: var(--wb-text-muted);
  font-weight: 500;
}
.order-table .num {
  text-align: right;
}
.order-table .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.order-table .dim {
  color: var(--wb-text-muted);
  font-size: 12px;
}
.fee-detail {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--wb-text-muted);
  font-size: 12px;
}
.empty-state {
  padding: 24px;
  text-align: center;
  font-size: 13px;
}
.empty-hint {
  color: var(--wb-text-muted);
  font-size: 12px;
  margin: 2px 0;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 10px;
}
.ghost-btn,
.primary-btn {
  border: 1px solid var(--wb-border);
  background: var(--wb-surface);
  color: var(--wb-text);
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.primary-btn {
  background: var(--wb-primary);
  border-color: var(--wb-primary);
  color: var(--wb-primary-contrast);
}
.ghost-btn:hover {
  background: var(--wb-hover);
}
.ghost-btn:disabled,
.primary-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.ghost-btn.small {
  padding: 4px 10px;
  font-size: 12px;
}
</style>
