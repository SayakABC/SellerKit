<script setup lang="ts">
// ui-plugins/ae-profit/src/components/ProfitStatsPanel.vue
// M1 统计页 v1：全周期利润 KPI + 日月趋势（范围/粒度可切）+ TOP（款编码/订单）+ 费用构成 + 成本覆盖率。
// 数据源：aeProfitStats（主进程利润引擎，CNY 基准，见 electron/ae-engine.ts）。
// 口径提示：合计/TOP 为全周期口径；范围（rangeDays）与粒度仅作用于下方趋势窗口。

import { computed, onMounted, ref, watch } from 'vue';
import { aeProfitStats } from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import { fmtBucket, fmtInt, fmtMoney, feeLabel, fmtTime } from '../format';
import type { AeProfitOverview, AeTrendPoint } from '@/types';

const props = defineProps<{ refreshKey: number }>();
const emit = defineEmits<{ (e: 'open', anchor: 'cost' | 'rates'): void }>();

/** 趋势范围（天）与聚合粒度；引擎默认 rangeDays=90 / granularity=month，趋势最多展示最近 120 桶 */
const RANGE_OPTIONS = [
  { label: '近 30 天', days: 30 },
  { label: '近 90 天', days: 90 },
  { label: '近 365 天', days: 365 },
  { label: '全部', days: 3650 },
] as const;

const overview = ref<AeProfitOverview | null>(null);
const loading = ref(false);
const granularity = ref<'day' | 'month'>('month');
const rangeDays = ref(90);
const TREND_CAP = 120;

const totals = computed(() => overview.value?.totals ?? null);
const empty = computed(() => !!overview.value && overview.value.coverage.orderCount === 0);

/** 趋势展示窗口：升序切片取最近 TREND_CAP 桶 */
const trendShown = computed<AeTrendPoint[]>(() => (overview.value?.trend ?? []).slice(-TREND_CAP));
/** 绝对值最大毛利（柱状图缩放基准） */
const maxAbsGross = computed(() => {
  let m = 0;
  for (const t of trendShown.value) m = Math.max(m, Math.abs(t.grossProfitCny));
  return m || 1;
});
const trendSum = computed(() => {
  let orders = 0;
  let income = 0;
  let cost = 0;
  let gross = 0;
  for (const t of trendShown.value) {
    orders += t.orders;
    income += t.incomeCny;
    cost += t.costCny;
    gross += t.grossProfitCny;
  }
  return { orders, income, cost, gross };
});
const trendLabelStep = computed(() => Math.ceil(trendShown.value.length / 18));
const chartSlotW = 15;
const chartMidY = 92;

function barStyle(v: number): Record<string, string> {
  const h = Math.max(2, Math.round((Math.abs(v) / maxAbsGross.value) * (chartMidY - 4)));
  return v >= 0 ? { height: h + 'px', bottom: chartMidY + 'px' } : { height: h + 'px', top: chartMidY + 'px' };
}

const kpis = computed(() => {
  const t = totals.value;
  if (!t) return [];
  const cards: { label: string; value: string; tone: 'primary' | 'ok' | 'danger' | 'plain' }[] = [
    { label: '订单数（计入）', value: fmtInt(t.orders), tone: 'plain' },
    { label: '净收入 CNY', value: fmtMoney(t.incomeCny), tone: 'primary' },
    { label: '商品成本 CNY', value: fmtMoney(t.costCny), tone: 'plain' },
    { label: '费用 CNY', value: fmtMoney(t.feeCny), tone: 'plain' },
    { label: '毛利 CNY', value: fmtMoney(t.grossProfitCny), tone: t.grossProfitCny >= 0 ? 'ok' : 'danger' },
    { label: '运营利润 CNY', value: fmtMoney(t.operatingProfitCny), tone: t.operatingProfitCny >= 0 ? 'ok' : 'danger' },
  ];
  return cards;
});

/** 成本命中（行级）：命中数 / 有款编码行数 */
const matchedShare = computed(() => {
  const c = overview.value?.coverage;
  if (!c) return null;
  return { matched: c.matchedLines, codeLines: c.codeLines };
});

function barW(v: number, max: number): number {
  return max > 0 ? Math.max(2, (v / max) * 100) : 0;
}

/** 订单状态展示（引擎透传原始状态，仅识别常见枚举；未知回退原文） */
function statusText(s: string): string {
  if (s === 'finished') return '已完结';
  if (s === 'in_transit' || s === 'unfinished') return '在途';
  return s || '—';
}

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const r = await aeProfitStats({ granularity: granularity.value, rangeDays: rangeDays.value });
    if (r.success && r.data !== undefined) overview.value = r.data;
    else toast.error(`加载利润统计失败：${r.error ?? '未知错误'}`);
  } finally {
    loading.value = false;
  }
}

watch(() => [granularity.value, rangeDays.value], () => void load());
watch(() => props.refreshKey, () => void load());
onMounted(() => void load());
</script>

<template>
  <div class="space-y-4">
    <div v-if="loading && !overview" class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] px-4 py-10 text-center text-sm text-[var(--wb-text-muted)]">
      正在统计利润…
    </div>

    <!-- 空态：无订单 -->
    <div v-else-if="empty" class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] px-6 py-10 text-center text-[var(--wb-text)]">
      <p class="text-sm font-medium">还没有可统计的订单</p>
      <p class="mt-1 text-xs text-[var(--wb-text-muted)]">
        通过「订单明细」页右上角「复制 curl 样例」本地推送示例帧，或安装 Chrome 扩展采集真实订单后，利润统计将自动生成。
      </p>
    </div>

    <template v-else-if="overview">
      <!-- 缺汇率提示 -->
      <div
        v-if="overview.totals.missingRateOrders > 0"
        class="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--wb-warning)] bg-[var(--wb-warning-soft)] px-4 py-2.5 text-sm text-[var(--wb-text)]"
      >
        <span class="text-[var(--wb-warning)]">⚠</span>
        <span>
          有 <b>{{ overview.totals.missingRateOrders }}</b> 单因缺少汇率被跳过（未计入合计）。
          去「成本与汇率 → 汇率维护」补充币种汇率后刷新。
        </span>
        <button
          class="rounded-lg border border-[var(--wb-warning)] px-2.5 py-1 text-xs text-[var(--wb-warning)] hover:bg-[var(--wb-warning-soft)]"
          @click="emit('open', 'rates')"
        >
          去补汇率
        </button>
      </div>

      <!-- KPI 合计 -->
      <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="text-sm font-medium text-[var(--wb-text)]">全周期利润（CNY 基准）</span>
          <span class="text-xs text-[var(--wb-text-muted)]">
            全部订单口径 · 净收入已扣退款 · 范围切换只作用于下方趋势窗口
          </span>
        </div>
        <div class="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <div
            v-for="c in kpis"
            :key="c.label"
            class="rounded-lg border border-[var(--wb-border)] bg-[var(--wb-surface-2)] p-3"
            :class="c.tone === 'ok' ? '!border-[var(--wb-success)]' : c.tone === 'danger' ? '!border-[var(--wb-danger)]' : ''"
          >
            <div class="text-xs text-[var(--wb-text-muted)]">{{ c.label }}</div>
            <div
              class="mt-1 text-lg font-semibold tabular-nums"
              :class="c.tone === 'ok' ? 'text-[var(--wb-success)]' : c.tone === 'danger' ? 'text-[var(--wb-danger)]' : c.tone === 'primary' ? 'text-[var(--wb-primary)]' : 'text-[var(--wb-text)]'"
            >
              {{ c.value }}
            </div>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <!-- 日月趋势 -->
        <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4 xl:col-span-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-medium text-[var(--wb-text)]">利润趋势</span>
            <span class="text-xs text-[var(--wb-text-muted)]">毛利（绿盈红亏）</span>
            <div class="ml-auto flex flex-wrap items-center gap-1.5">
              <div class="flex overflow-hidden rounded-lg border border-[var(--wb-border)]">
                <button
                  v-for="g in ['day', 'month'] as const"
                  :key="g"
                  class="px-2.5 py-1 text-xs transition-colors"
                  :class="granularity === g ? 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)]' : 'text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)]'"
                  @click="granularity = g"
                >
                  {{ g === 'day' ? '按日' : '按月' }}
                </button>
              </div>
              <div class="flex overflow-hidden rounded-lg border border-[var(--wb-border)]">
                <button
                  v-for="r in RANGE_OPTIONS"
                  :key="r.days"
                  class="px-2.5 py-1 text-xs transition-colors"
                  :class="rangeDays === r.days ? 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)]' : 'text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)]'"
                  @click="rangeDays = r.days"
                >
                  {{ r.label }}
                </button>
              </div>
            </div>
          </div>

          <div v-if="trendShown.length" class="mt-4">
            <div class="overflow-x-auto">
              <div
                class="relative"
                :style="{ height: chartMidY * 2 + 'px', minWidth: Math.max(320, trendShown.length * (chartSlotW + 2) + 8) + 'px' }"
              >
                <!-- 0 轴 -->
                <div class="absolute inset-x-0 border-t border-dashed border-[var(--wb-border)]" :style="{ top: chartMidY + 'px' }" />
                <div class="absolute inset-y-0 flex items-stretch">
                  <div
                    v-for="(t, i) in trendShown"
                    :key="t.bucket"
                    class="relative"
                    :style="{ width: chartSlotW + 'px', marginRight: i === trendShown.length - 1 ? 0 : '2px' }"
                    :title="`${t.bucket}：订单 ${t.orders} · 收入 ${fmtMoney(t.incomeCny)} · 成本 ${fmtMoney(t.costCny)} · 毛利 ${fmtMoney(t.grossProfitCny)}`"
                  >
                    <div
                      class="absolute w-full rounded-sm"
                      :class="t.grossProfitCny >= 0 ? 'bg-[var(--wb-success)]' : 'bg-[var(--wb-danger)]'"
                      :style="barStyle(t.grossProfitCny)"
                    />
                  </div>
                </div>
              </div>
              <!-- 横轴标签：稀疏采样 -->
              <div
                class="relative"
                :style="{ minWidth: Math.max(320, trendShown.length * (chartSlotW + 2) + 8) + 'px' }"
              >
                <div class="relative" style="height: 16px">
                  <span
                    v-for="(t, i) in trendShown"
                    :key="'l' + t.bucket"
                    v-show="i % trendLabelStep === 0"
                    class="absolute top-0 -translate-x-1/2 text-[10px] leading-4 text-[var(--wb-text-muted)]"
                    :style="{ left: i * (chartSlotW + 2) + chartSlotW / 2 + 'px' }"
                  >
                    {{ fmtBucket(t.bucket, granularity) }}
                  </span>
                </div>
              </div>
            </div>
            <div class="mt-2 text-xs text-[var(--wb-text-muted)]">
              窗口合计：订单 <b class="text-[var(--wb-text)]">{{ fmtInt(trendSum.orders) }}</b> · 收入
              <b class="text-[var(--wb-text)]">{{ fmtMoney(trendSum.income) }}</b> · 成本
              <b class="text-[var(--wb-text)]">{{ fmtMoney(trendSum.cost) }}</b> · 毛利
              <b class="text-[var(--wb-text)]">{{ fmtMoney(trendSum.gross) }}</b>
              <span v-if="overview.trend.length > TREND_CAP">（仅显示最近 {{ TREND_CAP }} 桶）</span>
            </div>
          </div>
          <p v-else class="mt-4 text-xs text-[var(--wb-text-muted)]">所选范围内暂无订单。</p>
        </div>

        <!-- 费用构成 + 覆盖率 -->
        <div class="space-y-4 xl:col-span-2">
          <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4">
            <div class="text-sm font-medium text-[var(--wb-text)]">费用构成（订单级，不含退款）</div>
            <div v-if="overview.feeBreakdown.length" class="mt-3 space-y-2.5">
              <div v-for="f in overview.feeBreakdown" :key="f.category" class="text-xs">
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate text-[var(--wb-text)]">{{ feeLabel(f.category) }}</span>
                  <span class="shrink-0 tabular-nums text-[var(--wb-text-muted)]">
                    {{ fmtMoney(f.totalCny) }} ·
                    {{ overview.totals.feeCny > 0 ? Math.round((f.totalCny / overview.totals.feeCny) * 100) + '%' : '—' }}
                  </span>
                </div>
                <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--wb-surface-2)]">
                  <div
                    class="h-full rounded-full bg-[var(--wb-primary)]"
                    :style="{ width: barW(f.totalCny, overview.feeBreakdown[0].totalCny) + '%' }"
                  />
                </div>
              </div>
            </div>
            <p v-else class="mt-3 text-xs text-[var(--wb-text-muted)]">暂无费用科目（费用在订单侧按 fees 数组推送）。</p>
            <p class="mt-3 text-[11px] leading-5 text-[var(--wb-text-muted)]">
              口径：订单级 fees 科目折 CNY；退款/纠纷类在收入侧扣减，不在此处重复。
            </p>
          </div>

          <!-- 覆盖率 -->
          <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-[var(--wb-text)]">成本覆盖率</span>
              <span class="text-xs text-[var(--wb-text-muted)]">
                {{ fmtInt(overview.coverage.orderCount) }} 单 · {{ fmtInt(overview.coverage.lineCount) }} 行（含缺汇率）
              </span>
            </div>
            <div v-if="matchedShare && matchedShare.codeLines > 0" class="mt-3">
              <div class="flex items-center justify-between text-xs">
                <span class="text-[var(--wb-text)]">命中成本表</span>
                <span class="tabular-nums text-[var(--wb-text-muted)]">
                  {{ fmtInt(matchedShare.matched) }} / {{ fmtInt(matchedShare.codeLines) }} 行（有款编码）
                </span>
              </div>
              <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--wb-surface-2)]">
                <div
                  class="h-full rounded-full"
                  :class="matchedShare.matched >= matchedShare.codeLines ? 'bg-[var(--wb-success)]' : matchedShare.matched > 0 ? 'bg-[var(--wb-warning)]' : 'bg-[var(--wb-danger)]'"
                  :style="{ width: (matchedShare.matched / matchedShare.codeLines) * 100 + '%' }"
                />
              </div>
              <p class="mt-2 text-[11px] leading-5 text-[var(--wb-text-muted)]">
                毛利/运营利润只对「有款编码且命中成本表」的 SKU 行扣成本；其余行成本按 0 计。
                <span v-if="matchedShare.matched < matchedShare.codeLines">
                  请到「成本与汇率」从拿货对账导入成本快照以提升准确率。
                </span>
              </p>
              <button
                v-if="matchedShare.matched < matchedShare.codeLines"
                class="mt-2 rounded-lg border border-[var(--wb-primary)] px-2.5 py-1 text-xs text-[var(--wb-primary)] hover:bg-[var(--wb-primary-soft)]"
                @click="emit('open', 'cost')"
              >
                去导入成本
              </button>
            </div>
            <p v-else class="mt-3 text-xs leading-5 text-[var(--wb-text-muted)]">
              尚无带款编码的 SKU 行，或成本表为空。
              <button class="text-[var(--wb-primary)] hover:underline" @click="emit('open', 'cost')">前往成本衔接导入</button>。
            </p>
          </div>
        </div>
      </div>

      <!-- TOP 款编码 + TOP 订单 -->
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-[var(--wb-text)]">TOP 款编码（毛利）</span>
            <span class="text-xs text-[var(--wb-text-muted)]">全周期 · 前 20</span>
          </div>
          <div v-if="overview.topStyles.length" class="mt-2 overflow-x-auto">
            <table class="w-full min-w-[520px] text-xs">
              <thead class="border-b border-[var(--wb-border)] text-[var(--wb-text-muted)]">
                <tr>
                  <th class="py-1.5 pr-2 text-left font-normal">#</th>
                  <th class="py-1.5 pr-2 text-left font-normal">款编码 / 款名</th>
                  <th class="py-1.5 pr-2 text-right font-normal">件数</th>
                  <th class="py-1.5 pr-2 text-right font-normal">收入</th>
                  <th class="py-1.5 pr-2 text-right font-normal">成本</th>
                  <th class="py-1.5 text-right font-normal">毛利</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(s, i) in overview.topStyles"
                  :key="s.styleCode"
                  class="border-b border-[var(--wb-border)] last:border-0"
                >
                  <td class="py-2 pr-2 text-[var(--wb-text-muted)]">{{ i + 1 }}</td>
                  <td class="py-2 pr-2">
                    <div class="font-mono text-[var(--wb-text)]">{{ s.styleCode }}</div>
                    <div class="truncate text-[11px] text-[var(--wb-text-muted)]">{{ s.styleName || '—' }}</div>
                  </td>
                  <td class="py-2 pr-2 text-right tabular-nums text-[var(--wb-text)]">{{ fmtInt(s.qty) }}</td>
                  <td class="py-2 pr-2 text-right tabular-nums text-[var(--wb-text)]">{{ fmtMoney(s.incomeCny) }}</td>
                  <td class="py-2 pr-2 text-right tabular-nums text-[var(--wb-text)]">{{ fmtMoney(s.costCny) }}</td>
                  <td
                    class="py-2 text-right tabular-nums"
                    :class="s.grossProfitCny >= 0 ? 'text-[var(--wb-success)]' : 'text-[var(--wb-danger)]'"
                  >
                    {{ fmtMoney(s.grossProfitCny) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="mt-3 text-xs text-[var(--wb-text-muted)]">暂无款编码维度数据。</p>
        </div>

        <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-[var(--wb-text)]">TOP 订单（毛利）</span>
            <span class="text-xs text-[var(--wb-text-muted)]">全周期 · 前 20</span>
          </div>
          <div v-if="overview.topOrders.length" class="mt-2 max-h-[430px] overflow-auto">
            <table class="w-full min-w-[600px] text-xs">
              <thead class="sticky top-0 border-b border-[var(--wb-border)] bg-[var(--wb-surface)] text-[var(--wb-text-muted)]">
                <tr>
                  <th class="py-1.5 pr-2 text-left font-normal">订单号</th>
                  <th class="py-1.5 pr-2 text-left font-normal">时间</th>
                  <th class="py-1.5 pr-2 text-left font-normal">状态</th>
                  <th class="py-1.5 pr-2 text-right font-normal">收入 CNY</th>
                  <th class="py-1.5 pr-2 text-right font-normal">成本</th>
                  <th class="py-1.5 text-right font-normal">毛利</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="s in overview.topOrders"
                  :key="s.orderId"
                  class="border-b border-[var(--wb-border)] last:border-0"
                >
                  <td class="py-2 pr-2 font-mono text-[var(--wb-text)]">{{ s.orderId }}</td>
                  <td class="py-2 pr-2 whitespace-nowrap text-[var(--wb-text-muted)]">{{ fmtTime(s.orderTime) }}</td>
                  <td class="py-2 pr-2">
                    <span class="rounded bg-[var(--wb-surface-2)] px-1.5 py-0.5 text-[var(--wb-text-muted)]">
                      {{ statusText(s.status) }}
                    </span>
                  </td>
                  <td class="py-2 pr-2 text-right tabular-nums text-[var(--wb-text)]">{{ fmtMoney(s.incomeCny) }}</td>
                  <td class="py-2 pr-2 text-right tabular-nums text-[var(--wb-text)]">{{ fmtMoney(s.costCny) }}</td>
                  <td
                    class="py-2 text-right tabular-nums"
                    :class="s.grossProfitCny >= 0 ? 'text-[var(--wb-success)]' : 'text-[var(--wb-danger)]'"
                  >
                    {{ fmtMoney(s.grossProfitCny) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="mt-3 text-xs text-[var(--wb-text-muted)]">暂无订单维度数据。</p>
        </div>
      </div>

      <!-- 口径注脚 -->
      <p class="px-1 text-[11px] leading-5 text-[var(--wb-text-muted)]">
        口径：① 汇率走 ae_rates 表，缺失币种订单整单跳过并计入「缺汇率单」；② 成本来自「成本与汇率」成本表（源：拿货对账快照），无款编码或未命中 SKU 行成本按 0；
        ③ 毛利 = 净收入 − 成本；运营利润 = 毛利 − 费用（fees 合计）；④ 净收入 =（商品+运费）× 汇率 − 退款/纠纷。
      </p>
    </template>

    <!-- 兜底：非加载中且无概览（加载失败等） -->
    <div
      v-else
      class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] px-6 py-10 text-center text-sm text-[var(--wb-text-muted)]"
    >
      统计暂不可用，请点击右上角「刷新」重试。
    </div>
  </div>
</template>
