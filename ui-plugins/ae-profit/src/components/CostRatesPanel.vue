<script setup lang="ts">
// ui-plugins/ae-profit/src/components/CostRatesPanel.vue
// M1 数据基础维护：① 成本衔接（拿货对账快照 → ae_cost_map 全量替换 + 成本表浏览）
// ② 汇率维护（ae_rates upsert）。金额单位：成本表单价分 → 元展示。

import { computed, onMounted, ref, watch } from 'vue';
import {
  aeCostMapImport,
  aeCostMapList,
  aeRateList,
  aeRateUpsert,
  purchaseCostSnapshot,
} from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import { fmtYuanFromCents, fmtTime, fmtInt } from '../format';
import type { AeCostMapItem, AeRateItem } from '@/types';

const props = defineProps<{ refreshKey: number; subFocus?: 'cost' | 'rates' | null }>();

const activeSub = ref<'cost' | 'rates'>('cost');
watch(
  () => props.subFocus,
  (v) => {
    if (v) activeSub.value = v;
  },
);

// ---- 成本表 ----
const costRows = ref<AeCostMapItem[]>([]);
const costLoading = ref(false);
const costSearch = ref('');
const importBusy = ref(false);
const lastImportAt = ref('');
const snapInfo = ref<{ count: number; lastBizDate: string } | null>(null);

const filteredCost = computed(() => {
  const q = costSearch.value.trim().toUpperCase();
  if (!q) return costRows.value;
  return costRows.value.filter((r) => r.styleCode.toUpperCase().includes(q) || (r.styleName || '').toUpperCase().includes(q));
});
const costSumCents = computed(() => filteredCost.value.reduce((s, r) => s + r.unitPriceCents * r.sampleCount, 0));

async function loadCost(): Promise<void> {
  costLoading.value = true;
  try {
    const r = await aeCostMapList();
    if (r.success && r.data !== undefined) costRows.value = r.data;
    else toast.error(`加载成本表失败：${r.error ?? '未知错误'}`);
  } finally {
    costLoading.value = false;
  }
}

async function loadSnapInfo(): Promise<void> {
  const r = await purchaseCostSnapshot();
  if (r.success && r.data !== undefined) {
    snapInfo.value = { count: r.data.count, lastBizDate: r.data.items[0]?.lastBizDate ?? '' };
  } else {
    snapInfo.value = null;
    toast.error(`读取拿货成本快照失败：${r.error ?? '未知错误'}`);
  }
}

async function doImport(): Promise<void> {
  if (importBusy.value) return;
  importBusy.value = true;
  try {
    const snap = await purchaseCostSnapshot();
    if (!snap.success || snap.data === undefined) {
      toast.error(`读取拿货成本快照失败：${snap.error ?? '未知错误'}`);
      return;
    }
    const items = snap.data.items.map((it) => ({
      styleCode: it.styleCode,
      styleName: it.styleName,
      unitPriceCents: it.weightedPriceCents,
      sampleCount: it.sampleCount,
      lastBizDate: it.lastBizDate,
    }));
    if (!items.length) {
      toast.info('拿货对账暂无成本快照（还没有可汇总的拿货单）');
      return;
    }
    const imp = await aeCostMapImport(items);
    if (!imp.success || imp.data === undefined) {
      toast.error(`导入成本失败：${imp.error ?? '未知错误'}`);
      return;
    }
    lastImportAt.value = new Date().toISOString();
    toast.success(`已导入成本 ${fmtInt(items.length)} 行（替换 ${fmtInt(imp.data.replaced)} 条，源：拿货对账）`);
    snapInfo.value = { count: items.length, lastBizDate: items[0]?.lastBizDate ?? '' };
    await loadCost();
  } finally {
    importBusy.value = false;
  }
}

// ---- 汇率 ----
const rates = ref<AeRateItem[]>([]);
const drafts = ref<Record<string, string>>({});
const rateLoading = ref(false);
const newCur = ref('');
const newRate = ref('');

async function loadRates(): Promise<void> {
  rateLoading.value = true;
  try {
    const r = await aeRateList();
    if (r.success && r.data !== undefined) {
      rates.value = r.data;
      const d: Record<string, string> = {};
      for (const item of r.data) d[item.fromCurrency] = String(item.rateToCny);
      drafts.value = d;
    } else {
      toast.error(`加载汇率失败：${r.error ?? '未知错误'}`);
    }
  } finally {
    rateLoading.value = false;
  }
}

async function saveRate(cur: string): Promise<void> {
  const v = Number(drafts.value[cur]);
  if (!Number.isFinite(v) || v <= 0) {
    toast.error('汇率必须为大于 0 的数字');
    return;
  }
  const r = await aeRateUpsert(cur.toUpperCase(), v);
  if (r.success) {
    toast.success(`已保存 ${cur.toUpperCase()} → ${v} CNY`);
    await loadRates();
  } else {
    toast.error(`保存失败：${r.error ?? '未知错误'}`);
  }
}

async function addRate(): Promise<void> {
  const cur = newCur.value.trim().toUpperCase();
  const v = Number(newRate.value);
  if (!/^[A-Z]{2,4}$/.test(cur)) {
    toast.error('币种请输入 2-4 位字母代码，如 USD / EUR');
    return;
  }
  if (!Number.isFinite(v) || v <= 0) {
    toast.error('汇率必须为大于 0 的数字');
    return;
  }
  const r = await aeRateUpsert(cur, v);
  if (r.success) {
    toast.success(`已添加 ${cur} → ${v} CNY`);
    newCur.value = '';
    newRate.value = '';
    await loadRates();
  } else {
    toast.error(`保存失败：${r.error ?? '未知错误'}`);
  }
}

async function reloadAll(): Promise<void> {
  await Promise.all([loadCost(), loadRates()]);
}

watch(() => props.refreshKey, () => void reloadAll());
onMounted(() => void reloadAll());
</script>

<template>
  <div class="space-y-4">
    <!-- 子页切换 -->
    <div class="flex w-fit overflow-hidden rounded-lg border border-[var(--wb-border)]">
      <button
        v-for="s in [
          { id: 'cost', label: '成本衔接' },
          { id: 'rates', label: '汇率维护' },
        ] as const"
        :key="s.id"
        class="px-3.5 py-1.5 text-xs transition-colors"
        :class="activeSub === s.id ? 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)]' : 'text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)]'"
        @click="activeSub = s.id"
      >
        {{ s.label }}
      </button>
    </div>

    <!-- 成本衔接 -->
    <div v-show="activeSub === 'cost'" class="space-y-4">
      <!-- 导入卡 -->
      <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm font-medium text-[var(--wb-text)]">成本来源：拿货对账</span>
          <span class="text-xs text-[var(--wb-text-muted)]">
            毛利只对命中成本表的 SKU 行扣成本（ae_cost_map · 按款编码精确匹配）
          </span>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--wb-text-muted)]">
          <span>拿货快照：{{ snapInfo ? fmtInt(snapInfo.count) + ' 行' : '—' }}</span>
          <span v-if="snapInfo && snapInfo.lastBizDate">最近业务日 {{ snapInfo.lastBizDate.slice(0, 10) }}</span>
          <span>成本表现有 {{ fmtInt(costRows.length) }} 款</span>
          <span v-if="lastImportAt">上次导入 {{ fmtTime(lastImportAt) }}</span>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            class="rounded-lg bg-[var(--wb-primary)] px-3 py-1.5 text-xs text-[var(--wb-primary-contrast)] hover:bg-[var(--wb-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="importBusy"
            @click="doImport"
          >
            {{ importBusy ? '导入中…' : '从拿货对账导入/刷新成本' }}
          </button>
          <button
            class="rounded-lg border border-[var(--wb-border)] px-3 py-1.5 text-xs text-[var(--wb-text)] hover:bg-[var(--wb-hover)]"
            @click="loadSnapInfo"
          >
            预览快照
          </button>
        </div>
        <p class="mt-2 text-[11px] text-[var(--wb-text-muted)]">
          导入为「全量替换」：以拿货单加权均价重建成本表；已删除款编码的成本行会被清除。
        </p>
      </div>

      <!-- 成本表浏览 -->
      <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm font-medium text-[var(--wb-text)]">成本表（{{ fmtInt(filteredCost.length) }} 款）</span>
          <span class="text-xs text-[var(--wb-text-muted)]">
            成本单价按加权样本均价（分 → 元）· Σ(单价 × 样本数) = {{ fmtYuanFromCents(costSumCents) }} 元
          </span>
          <input
            v-model="costSearch"
            class="wb-input ml-auto w-56 rounded-lg border border-[var(--wb-border)] bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-[var(--wb-primary)]"
            placeholder="按款编码/款名过滤…"
          />
        </div>
        <div v-if="costLoading && !costRows.length" class="mt-4 py-6 text-center text-xs text-[var(--wb-text-muted)]">
          正在加载成本表…
        </div>
        <div v-else-if="costRows.length" class="mt-3 max-h-[420px] overflow-auto">
          <table class="w-full min-w-[760px] text-xs">
            <thead class="sticky top-0 border-b border-[var(--wb-border)] bg-[var(--wb-surface)] text-left text-[var(--wb-text-muted)]">
              <tr>
                <th class="py-1.5 pr-2 font-normal">款编码</th>
                <th class="py-1.5 pr-2 font-normal">款名</th>
                <th class="py-1.5 pr-2 text-right font-normal">单价（元）</th>
                <th class="py-1.5 pr-2 text-right font-normal">样本数</th>
                <th class="py-1.5 pr-2 font-normal">最近业务日</th>
                <th class="py-1.5 pr-2 font-normal">来源</th>
                <th class="py-1.5 font-normal">更新时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in filteredCost" :key="r.styleCode" class="border-b border-[var(--wb-border)] last:border-0">
                <td class="py-2 pr-2 font-mono text-[var(--wb-text)]">{{ r.styleCode }}</td>
                <td class="py-2 pr-2">
                  <span class="line-clamp-1" :title="r.styleName">{{ r.styleName || '—' }}</span>
                </td>
                <td class="py-2 pr-2 text-right tabular-nums text-[var(--wb-text)]">{{ fmtYuanFromCents(r.unitPriceCents) }}</td>
                <td class="py-2 pr-2 text-right tabular-nums text-[var(--wb-text-muted)]">{{ fmtInt(r.sampleCount) }}</td>
                <td class="py-2 pr-2 text-[var(--wb-text-muted)]">{{ r.lastBizDate ? r.lastBizDate.slice(0, 10) : '—' }}</td>
                <td class="py-2 pr-2 text-[var(--wb-text-muted)]">{{ r.source }}</td>
                <td class="py-2 whitespace-nowrap text-[var(--wb-text-muted)]">{{ fmtTime(r.updatedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="mt-4 py-4 text-center text-xs text-[var(--wb-text-muted)]">
          成本表为空。请先在拿货对账模块录入拿货单并完成对账，再回到本页一键导入。
        </p>
      </div>
    </div>

    <!-- 汇率维护 -->
    <div v-show="activeSub === 'rates'" class="space-y-4">
      <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm font-medium text-[var(--wb-text)]">币种汇率（1 币种 = rate CNY）</span>
          <span class="text-xs text-[var(--wb-text-muted)]">缺汇率的订单整单跳过利润统计</span>
        </div>
        <p class="mt-1 text-[11px] text-[var(--wb-text-muted)]">
          示例：EUR 行填 7.9 表示 €1 ≈ ¥7.90。行内修改后点「保存」即时生效（ae_rates upsert）。
        </p>
        <div v-if="rateLoading && !rates.length" class="mt-4 py-4 text-center text-xs text-[var(--wb-text-muted)]">加载中…</div>
        <div v-else class="mt-3 overflow-x-auto">
          <table class="w-full min-w-[460px] text-xs">
            <thead class="border-b border-[var(--wb-border)] text-left text-[var(--wb-text-muted)]">
              <tr>
                <th class="py-1.5 pr-2 font-normal">币种</th>
                <th class="py-1.5 pr-2 font-normal">兑 CNY 汇率</th>
                <th class="py-1.5 pr-2 font-normal">更新时间</th>
                <th class="py-1.5 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rates" :key="r.fromCurrency" class="border-b border-[var(--wb-border)] last:border-0">
                <td class="py-2 pr-2 font-mono text-[var(--wb-text)]">{{ r.fromCurrency }}</td>
                <td class="py-2 pr-2">
                  <input
                    v-model="drafts[r.fromCurrency]"
                    type="number"
                    step="any"
                    min="0"
                    class="wb-input w-32 rounded-lg border border-[var(--wb-border)] bg-transparent px-2 py-1 text-xs tabular-nums outline-none focus:border-[var(--wb-primary)]"
                  />
                </td>
                <td class="py-2 pr-2 text-[var(--wb-text-muted)]">{{ fmtTime(r.updatedAt) }}</td>
                <td class="py-2 text-right">
                  <button
                    class="rounded-lg border border-[var(--wb-primary)] px-2.5 py-1 text-xs text-[var(--wb-primary)] hover:bg-[var(--wb-primary-soft)]"
                    @click="saveRate(r.fromCurrency)"
                  >
                    保存
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 新增币种 -->
        <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--wb-border)] pt-3">
          <span class="text-xs text-[var(--wb-text-muted)]">新增币种：</span>
          <input
            v-model="newCur"
            class="wb-input w-24 rounded-lg border border-[var(--wb-border)] bg-transparent px-2 py-1.5 text-xs uppercase outline-none focus:border-[var(--wb-primary)]"
            placeholder="如 EUR"
          />
          <span class="text-xs text-[var(--wb-text-muted)]">=</span>
          <input
            v-model="newRate"
            type="number"
            step="any"
            min="0"
            class="wb-input w-28 rounded-lg border border-[var(--wb-border)] bg-transparent px-2 py-1.5 text-xs tabular-nums outline-none focus:border-[var(--wb-primary)]"
            placeholder="兑 CNY 汇率"
          />
          <button
            class="rounded-lg bg-[var(--wb-primary)] px-3 py-1.5 text-xs text-[var(--wb-primary-contrast)] hover:bg-[var(--wb-primary-hover)]"
            @click="addRate"
          >
            添加
          </button>
        </div>
      </div>
      <p class="px-1 text-[11px] leading-5 text-[var(--wb-text-muted)]">
        汇率基准 CNY：订单币种外币按此处汇率折算成人民币参与利润统计；USD 等常见币种在首次入库时会自动写入 1:1 参考值，请按实际结算汇率修正。
      </p>
    </div>
  </div>
</template>
