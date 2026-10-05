<script setup lang="ts">
// ui-plugins/ae-profit/src/AeProfitView.vue
// 「订单采集」接收入口（原「利润追踪」）：**只保留采集接收端的状态与接入方式**。
//
// 2026-09-30（C9 收编）：「利润统计 / 订单明细 / 成本与汇率」已并入宿主**「算钱」**页
// （趋势/明细/成本表/汇率维护都在那里，读同一份主干数据）。这里不再重复一次 ——
// 「同一件事只有一个入口」是这套信息架构的铁律，重复入口会让两个页面的数字看起来像两套。
// 本岛独特的价值只剩这条链：浏览器扩展 / curl 把订单推到这个接收端，数据进 `oi_orders` 主干。

import { computed, onMounted, ref } from 'vue';
import { aeDbEnsure, aeReceiverStatus } from '@/core/services/ipc';
import { writeClipboard } from '@/core/services/clipboard';
import { toast } from '@/core/services/toast';
import type { AeReceiverStatus } from '@/types';

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
  } finally {
    refreshing.value = false;
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
        <h2>订单采集</h2>
        <span class="badge">接收端</span>
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
        接收端未运行。启动后：Chrome 扩展（SellerKitExtensions）在卖家后台点「采集本页订单」，或本页「复制 curl 样例」手动推送。
      </span>
    </div>

    <p v-if="status?.lastError" class="err-line">最近一次错误：{{ status.lastError }}</p>

    <div class="tip-card">
      <p class="tip-title">数据和利润看哪里</p>
      <p class="tip-body">
        推来的订单会落进订单主干（与 Excel 导入的订单同一张表，只是「来源」不同），
        直接在侧栏 <b>「算钱」</b> 页看利润、明细、趋势，以及成本表与汇率维护；
        <b>「拣货」</b> 页看待发货要拣什么。这里只负责把数据收进来。
      </p>
    </div>
  </div>
</template>

<style scoped>
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
.badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
}
.ae-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
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
.err-line {
  margin: 0;
  font-size: 12px;
  color: var(--wb-danger);
}
.tip-card {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  padding: 12px 14px;
}
.tip-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}
.tip-body {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--wb-text-muted);
}
</style>