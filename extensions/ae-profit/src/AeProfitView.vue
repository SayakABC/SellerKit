<script setup lang="ts">
// extensions/ae-profit/src/AeProfitView.vue
// 「利润追踪」主视图（M0）：接收端状态 + 收支汇总 + 订单明细列表。
// 数据经语义化 IPC 读取主进程 SQLite（ae_* 表）；本地联调可用「复制 curl 样例」推送模拟帧。

import { computed, onMounted, ref } from 'vue';
import {
  aeDbEnsure,
  aeOrderList,
  aeSummary,
  aeReceiverStatus,
} from '@/core/services/ipc';
import { writeClipboard } from '@/core/services/clipboard';
import { toast } from '@/core/services/toast';
import type { AeFeeItem, AeOrderListItem, AeReceiverStatus, AeSummary } from '@/types';

const PAGE_SIZE = 50;

const rows = ref<AeOrderListItem[]>([]);
const total = ref(0);
const page = ref(1);
const search = ref('');
const summary = ref<AeSummary | null>(null);
const status = ref<AeReceiverStatus | null>(null);
const loading = ref(false);

const totalPage = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const online = computed(() => !!status.value?.running);
const hasData = computed(() => rows.value.length > 0);

function fmtTime(s: string): string {
  if (!s) return '—';
  return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : s;
}
function fmtMoney(v: number): string {
  return (Number.isFinite(v) ? v : 0).toFixed(2);
}

/** 费用科目 label 字典（展示端：新增科目可在采集端直接推送，此处只补显示名；缺失回退原始 key） */
const FEE_LABELS: Record<string, string> = {
  platform_commission: '平台佣金',
  logistics_fee: '物流费(卖)',
  payment_channel: '支付通道费',
  refund: '退款/纠纷',
  dispute: '纠纷调整',
};
function feeLabel(category: string): string {
  return FEE_LABELS[category] ?? category;
}
function feeText(fees?: AeFeeItem[]): string {
  if (!fees || !fees.length) return '—';
  return fees.map((f) => `${feeLabel(f.category)} ${fmtMoney(f.amount)}`).join(' · ');
}
/** 单订单费用合计（订单内费用同币种，可直接相加） */
function feeTotal(fees?: AeFeeItem[]): string {
  if (!fees || !fees.length) return '—';
  return fmtMoney(fees.reduce((s, f) => s + (Number.isFinite(f.amount) ? f.amount : 0), 0));
}

async function loadStatus(): Promise<void> {
  const r = await aeReceiverStatus();
  if (r.success && r.data !== undefined) status.value = r.data;
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

async function refresh(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const ensure = await aeDbEnsure();
    if (!ensure.success) {
      toast.error(`初始化数据表失败：${ensure.error ?? '未知错误'}`);
      return;
    }
    await Promise.all([loadStatus(), loadSummary(), loadList()]);
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

async function copyCurlSample(): Promise<void> {
  const order = {
    orderId: '81041234567890123',
    shopName: 'Demo Store',
    site: 'ES',
    orderTime: '2026-09-01 10:00:00',
    status: '待发货',
    currency: 'EUR',
    goodsAmount: 12.34,
    shippingIncome: 2.5,
    fees: [
      { category: 'platform_commission', amount: 1.05 },
      { category: 'logistics_fee', amount: 3.2 },
      { category: 'payment_channel', amount: 0.3 },
    ],
    lines: [
      { productId: '1001', skuId: '2001', title: 'Demo Product', skuProps: 'Color:Red;Size:L', qty: 1, unitPrice: 12.34, goodsAmount: 12.34 },
    ],
  };
  const body = JSON.stringify({ schema: 'ae-order/v2', orders: [order] });
  const curl = [
    'curl -X POST http://127.0.0.1:46211/ae/ingest',
    "-H 'Content-Type: application/json'",
    "-H 'X-Ae-Token: sk-ae-dev-token'",
    `-d '${body}'`,
  ].join(' \\\n');
  const ok = await writeClipboard(curl);
  if (ok) toast.success('curl 样例已复制（v2 帧：费用走 fees 科目数组），终端粘贴运行即可入库');
  else toast.error('复制失败');
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <div class="ae-profit">
    <div class="ae-head">
      <div class="ae-title">
        <h2>利润追踪</h2>
        <span class="badge-m0">M0 · 明细</span>
      </div>
      <div class="ae-actions">
        <button class="ghost-btn" @click="copyCurlSample">复制 curl 样例</button>
        <button class="primary-btn" :disabled="loading" @click="refresh">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
    </div>

    <div class="status-line" :class="online ? 'is-online' : 'is-offline'">
      <span class="dot" />
      <span v-if="online">
        接收端在线 · 端口 {{ status?.port }} · 最近入库 {{ status?.lastIngestAt ? fmtTime(status.lastIngestAt) : '—' }}
      </span>
      <span v-else>
        接收端未运行。启动后：Chrome 扩展（SellerKitExtensions）在卖家后台点「采集本页订单」，或本页「复制 curl 样例」手动推送，数据即显示于此。
      </span>
    </div>

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
          <input
            v-model="search"
            placeholder="按订单号 / 店铺名搜索"
            @keyup.enter="onSearch"
          />
          <button class="ghost-btn small" @click="onSearch">搜索</button>
        </div>
        <span class="total-hint">共 {{ total }} 单</span>
      </div>

      <table v-if="hasData" class="order-table">
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
.ae-profit {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  color: var(--wb-text);
}
.ae-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ae-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ae-title h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.badge-m0 {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--wb-accent-soft, rgba(120, 120, 255, 0.15));
  color: var(--wb-accent, #8b8bff);
}
.ae-actions {
  display: flex;
  gap: 8px;
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
.status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--wb-border);
  background: var(--wb-surface);
}
.status-line .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-line.is-online {
  color: var(--wb-success);
}
.status-line.is-online .dot {
  background: var(--wb-success);
}
.status-line.is-offline {
  color: var(--wb-warning);
}
.status-line.is-offline .dot {
  background: var(--wb-warning);
}
.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.sum-card {
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
.order-table {
  width: 100%;
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
</style>
