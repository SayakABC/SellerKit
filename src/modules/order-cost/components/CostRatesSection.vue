<script setup lang="ts">
// src/modules/order-cost/components/CostRatesSection.vue
// 「算钱」页的**数据基础**区（C9 收编，2026-09-30）：款级成本表（只读浏览）+ 币种汇率（可改可加）。
//
// 为什么成本表只读：成本由「拿货对账」落账时**自动同步**（`purchase-cost-sync.ts`，
// 全量替换 source='purchase' 那一批），宿主不需要再给一个"手点导入"的按钮 —— 手点只会让
// 用户在两个地方看到两份成本。这里只回答"现在成本表里有什么、为什么这行毛利是空的"。
//
// 汇率必须可改：算钱的基准币是 CNY，外币订单整单靠 `ae_rates` 折算；缺汇率 → 该单不进利润合计。
// 岛内原先那份汇率维护随 C9 收编到这里（岛侧不再有入口）。

import { computed, onMounted, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import * as ipc from '@/core/services/ipc';
import type { AeCostMapItem, AeRateItem } from '@/types';

const props = defineProps<{
  /** 有"缺成本"的行时自动展开（否则默认收起，不抢主视线的位置） */
  attention?: boolean;
  /** 父页刷新时一起重取（成本表可能刚被拿货对账写新） */
  refreshKey?: number;
}>();

const open = ref(false);
const loaded = ref(false);
const costRows = ref<AeCostMapItem[]>([]);
const rates = ref<AeRateItem[]>([]);
const drafts = ref<Record<string, string>>({});
const loading = ref(false);
const search = ref('');
const newCur = ref('');
const newRate = ref('');

const filteredCost = computed(() => {
  const q = search.value.trim().toUpperCase();
  if (!q) return costRows.value;
  return costRows.value.filter(
    (r) => r.styleCode.toUpperCase().includes(q) || (r.styleName || '').toUpperCase().includes(q)
  );
});

/** 成本行主键是 (款编码, 生效日, 来源) —— 同一款可以有多段生效区间，key 不能只用 styleCode */
const costKey = (r: AeCostMapItem) => `${r.styleCode}|${r.effectiveFrom}|${r.source}`;

function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

function when(s: string): string {
  return s ? s.slice(0, 16).replace('T', ' ') : '—';
}

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    const [c, r] = await Promise.all([ipc.aeCostMapList(), ipc.aeRateList()]);
    if (c.success && c.data) costRows.value = c.data;
    else toast(`读取成本表失败：${c.error ?? '未知错误'}`, 'error');
    if (r.success && r.data) {
      rates.value = r.data;
      const d: Record<string, string> = {};
      for (const it of r.data) d[it.fromCurrency] = String(it.rateToCny);
      drafts.value = d;
    } else {
      toast(`读取汇率失败：${r.error ?? '未知错误'}`, 'error');
    }
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

async function saveRate(cur: string): Promise<void> {
  const v = Number(drafts.value[cur]);
  if (!Number.isFinite(v) || v <= 0) {
    toast('汇率必须为大于 0 的数字', 'error');
    return;
  }
  const r = await ipc.aeRateUpsert(cur.toUpperCase(), v);
  if (r.success) {
    toast(`已保存 ${cur.toUpperCase()} → ${v} CNY`, 'success');
    await refresh();
  } else {
    toast(`保存失败：${r.error ?? '未知错误'}`, 'error');
  }
}

async function addRate(): Promise<void> {
  const cur = newCur.value.trim().toUpperCase();
  const v = Number(newRate.value);
  if (!/^[A-Z]{2,4}$/.test(cur)) {
    toast('币种请输入 2-4 位字母代码，如 USD / EUR', 'error');
    return;
  }
  if (!Number.isFinite(v) || v <= 0) {
    toast('汇率必须为大于 0 的数字', 'error');
    return;
  }
  const r = await ipc.aeRateUpsert(cur, v);
  if (r.success) {
    toast(`已添加 ${cur} → ${v} CNY`, 'success');
    newCur.value = '';
    newRate.value = '';
    await refresh();
  } else {
    toast(`保存失败：${r.error ?? '未知错误'}`, 'error');
  }
}

function toggle(): void {
  if (open.value) open.value = false;
  else openNow();
}

// 「缺成本」的行出现了就自动摊开（它就是这个区能补的东西）；消失后**不自动收起** ——
// 用户刚翻开正在改汇率时收起来，比多占一点高度更烦。
watch(
  () => props.attention,
  (v) => {
    if (v) openNow();
  }
);

// 已经展开过就跟着页面主刷新一起重取（成本表可能刚被拿货对账写新）
watch(
  () => props.refreshKey,
  () => {
    if (loaded.value) void refresh();
  }
);

onMounted(() => {
  if (props.attention) openNow();
});

defineExpose({ refresh });
</script>

<template>
  <section class="cr" data-act="cost-rates">
    <button class="cr__head" data-act="cr-toggle" @click="toggle">
      <span class="cr__title">数据基础：成本与汇率</span>
      <span class="cr__sum">
        成本表 {{ costRows.length }} 行 · 汇率 {{ rates.length }} 个币种
      </span>
      <span v-if="attention && !open" class="wb-tag is-warn cr__alert" data-act="cr-attention"
        >有行缺成本</span
      >
      <span class="cr__chev">{{ open ? '收起' : '展开' }}</span>
    </button>

    <div v-if="open" class="cr__body">
      <div class="cr__block">
        <div class="cr__row">
          <span class="cr__label">款级成本（{{ filteredCost.length }} 行）</span>
          <span class="cr__note">
            来源：拿货对账加权均价 —— 落账即自动同步，无需手点；同一款可有多段生效区间
          </span>
          <input
            v-model="search"
            class="wb-input wb-input--sm cr__input cr__search"
            data-act="cost-search"
            placeholder="按款编码 / 款名过滤…"
          />
        </div>

        <table v-if="filteredCost.length" class="cr__table" data-act="cost-table">
          <thead>
            <tr>
              <th>款编码</th>
              <th>款名</th>
              <th class="cr__num">单价（元）</th>
              <th class="cr__num">样本数</th>
              <th>生效日</th>
              <th>来源</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in filteredCost" :key="costKey(r)">
              <td class="cr__mono">{{ r.styleCode }}</td>
              <td :class="{ cr__muted: !r.styleName }">{{ r.styleName || '—' }}</td>
              <td class="cr__num">{{ yuan(r.unitPriceCents) }}</td>
              <td class="cr__num cr__muted">{{ r.sampleCount }}</td>
              <td class="cr__mono">
                {{ r.effectiveFrom === '0000-01-01' ? '（最早）' : r.effectiveFrom }}
              </td>
              <td class="cr__muted">{{ r.source === 'manual' ? '手工' : '拿货对账' }}</td>
              <td class="cr__muted">{{ when(r.updatedAt) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="cr__empty" data-act="cost-empty">
          成本表为空 —— 去「货与成本」录入拿货单并完成对账，成本会自动同步到这里。
        </p>
      </div>

      <div class="cr__block">
        <div class="cr__row">
          <span class="cr__label">币种汇率（1 币种 = ? CNY）</span>
          <span class="cr__note">缺汇率的订单整单不进利润合计（不是按 0 算）</span>
        </div>

        <table v-if="rates.length" class="cr__table cr__table--rates" data-act="rate-table">
          <thead>
            <tr>
              <th>币种</th>
              <th>兑 CNY</th>
              <th>更新时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rates" :key="r.fromCurrency">
              <td class="cr__mono">{{ r.fromCurrency }}</td>
              <td>
                <input
                  v-model="drafts[r.fromCurrency]"
                  class="wb-input wb-input--sm cr__input cr__input--rate"
                  :data-act="`rate-input-${r.fromCurrency}`"
                  type="number"
                  step="any"
                  min="0"
                />
              </td>
              <td class="cr__muted">{{ when(r.updatedAt) }}</td>
              <td class="cr__right">
                <button
                  class="wb-btn wb-btn--sm cr__btn"
                  :data-act="`rate-save-${r.fromCurrency}`"
                  @click="saveRate(r.fromCurrency)"
                >
                  保存
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="cr__empty" data-act="rate-empty">还没有任何汇率 —— 外币订单会整单标缺。</p>

        <div class="cr__row cr__row--add">
          <span class="cr__note">新增币种</span>
          <input
            v-model="newCur"
            class="wb-input wb-input--sm cr__input cr__input--cur"
            data-act="rate-new-cur"
            placeholder="如 EUR"
          />
          <span class="cr__note">=</span>
          <input
            v-model="newRate"
            class="wb-input wb-input--sm cr__input cr__input--rate"
            data-act="rate-new-value"
            type="number"
            step="any"
            min="0"
            placeholder="兑 CNY"
          />
          <button
            class="wb-btn wb-btn--sm wb-btn--primary cr__btn"
            data-act="rate-add"
            @click="addRate"
          >
            添加
          </button>
        </div>
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
  width: 100%;
  padding: 10px 16px;
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
  margin-left: auto;
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
.cr__row--add {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--wb-border);
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
/* 输入框基座来自全局 .wb-input--sm；这里只留宽度与大小写等本页特有约束。 */
.cr__input--rate {
  width: 110px;
  font-variant-numeric: tabular-nums;
}
.cr__input--cur {
  width: 90px;
  text-transform: uppercase;
}
.cr__table {
  width: 100%;
  margin-top: 10px;
  border-collapse: collapse;
  font-size: 12px;
}
.cr__table--rates {
  min-width: 420px;
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
.cr__right {
  text-align: right;
}
.cr__mono {
  font-family: var(--wb-font-mono, ui-monospace, monospace);
}
.cr__muted {
  color: var(--wb-text-muted);
}
/* 按钮基座来自全局 .wb-btn--sm；.cr__btn 只作为本页可选钩子保留，无自有样式。 */
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
