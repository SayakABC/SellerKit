<script setup lang="ts">
// extensions/ae-profit/src/AeProfitView.vue
// 「利润追踪」主视图（M1）：Tab 外壳 = 利润统计(M1 统计页 v1) / 订单明细(M0) / 成本与汇率(M1 数据基础)。
// 接收端状态常驻头部；刷新按钮驱动 refreshKey 让各面板重载；统计面板可请求跳转到成本/汇率子页。

import { computed, onMounted, ref } from 'vue';
import { aeDbEnsure, aeReceiverStatus } from '@/core/services/ipc';
import { writeClipboard } from '@/core/services/clipboard';
import { toast } from '@/core/services/toast';
import ProfitStatsPanel from './components/ProfitStatsPanel.vue';
import OrderListPanel from './components/OrderListPanel.vue';
import CostRatesPanel from './components/CostRatesPanel.vue';
import type { AeReceiverStatus } from '@/types';

type TabId = 'stats' | 'orders' | 'cost';

const TABS: { id: TabId; label: string }[] = [
  { id: 'stats', label: '利润统计' },
  { id: 'orders', label: '订单明细' },
  { id: 'cost', label: '成本与汇率' },
];

const activeTab = ref<TabId>('stats');
const subFocus = ref<'cost' | 'rates' | null>(null);
const refreshKey = ref(0);
const status = ref<AeReceiverStatus | null>(null);
const refreshing = ref(false);

const online = computed(() => !!status.value?.running);

function fmtTime(s: string): string {
  if (!s) return '—';
  return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : s;
}

async function loadStatus(): Promise<void> {
  const r = await aeReceiverStatus();
  if (r.success && r.data !== undefined) status.value = r.data;
}

async function refresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const ensure = await aeDbEnsure();
    if (!ensure.success) {
      toast.error(`初始化数据表失败：${ensure.error ?? '未知错误'}`);
      return;
    }
    await loadStatus();
    refreshKey.value += 1; // 各面板 watch 后自行重载
  } finally {
    refreshing.value = false;
  }
}

/** 统计面板「去成本/去汇率」跳转：切到成本 Tab 并定位子页 */
function onOpenPanel(anchor: 'cost' | 'rates'): void {
  subFocus.value = anchor;
  activeTab.value = 'cost';
}

/** 手动切 Tab：成本 Tab 默认落到「成本衔接」子页；离开成本 Tab 时清空锚点，避免下次停留汇率页 */
function switchTab(id: TabId): void {
  activeTab.value = id;
  if (id !== 'cost') {
    subFocus.value = null;
  } else if (subFocus.value == null) {
    subFocus.value = 'cost';
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
  <div class="ae-shell">
    <div class="ae-head">
      <div class="ae-title">
        <h2>利润追踪</h2>
        <span class="badge-m1">M1 · 利润统计</span>
        <span class="badge-dim">明细 / 成本 / 汇率</span>
      </div>
      <div class="ae-actions">
        <button class="ghost-btn" @click="copyCurlSample">复制 curl 样例</button>
        <button class="primary-btn" :disabled="refreshing" @click="refresh">
          {{ refreshing ? '加载中…' : '刷新' }}
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

    <div class="tab-bar">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="tab-item"
        :class="activeTab === t.id ? 'is-active' : ''"
        @click="switchTab(t.id)"
      >
        {{ t.label }}
      </button>
    </div>

    <div v-show="activeTab === 'stats'" class="tab-pane">
      <ProfitStatsPanel :refresh-key="refreshKey" @open="onOpenPanel" />
    </div>
    <div v-show="activeTab === 'orders'" class="tab-pane">
      <OrderListPanel :refresh-key="refreshKey" />
    </div>
    <div v-show="activeTab === 'cost'" class="tab-pane">
      <CostRatesPanel :refresh-key="refreshKey" :sub-focus="subFocus" />
    </div>
  </div>
</template>

<style scoped>
/* 视图根：占满宿主 main（AppShell 对视图根 class=h-full），
   头/状态/Tab 固定，唯一滚动区为 .tab-pane —— 不再依赖外层裁剪 */
.ae-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  gap: 12px;
  padding: 16px;
  color: var(--wb-text);
}
.ae-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  column-gap: 12px;
  row-gap: 8px;
  flex-shrink: 0;
}
.ae-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.ae-title h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  white-space: nowrap;
}
.badge-m1 {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--wb-primary-soft, rgba(99, 102, 241, 0.12));
  color: var(--wb-primary, #6366f1);
}
.badge-dim {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
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
.tab-bar {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--wb-border);
}
.tab-item {
  padding: 8px 14px;
  font-size: 13px;
  color: var(--wb-text-muted);
  border: 0;
  background: transparent;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.tab-item:hover {
  color: var(--wb-text);
  background: var(--wb-hover);
  border-radius: 6px 6px 0 0;
}
.tab-item.is-active {
  color: var(--wb-primary);
  border-bottom-color: var(--wb-primary);
  font-weight: 500;
}
/* Tab 内容唯一滚动区：占满头部以下剩余高度，超高内部滚动，不再被外层裁剪 */
.tab-pane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.ae-actions {
  flex-shrink: 0;
}
</style>
