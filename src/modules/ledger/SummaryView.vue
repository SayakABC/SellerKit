<template>
  <div class="lg-sumview" data-act="summary-view">
    <div class="lg-sumview__bar">
      <div class="lg-month">
        <button class="wb-btn wb-btn--sm" type="button" data-act="summary-month-prev" aria-label="上个月" @click="shiftMonth(-1)">
          ‹
        </button>
        <button
          class="wb-btn wb-btn--sm lg-month__label"
          type="button"
          data-act="summary-month-now"
          title="回到本月"
          @click="toThisMonth"
        >
          {{ monthLabel }}
        </button>
        <button class="wb-btn wb-btn--sm" type="button" data-act="summary-month-next" aria-label="下个月" @click="shiftMonth(1)">
          ›
        </button>
        <button
          class="wb-btn wb-btn--sm lg-month__all"
          type="button"
          data-act="summary-month-all"
          :class="{ 'is-on': isAll }"
          :aria-pressed="isAll"
          title="不限月份：看全部日期的店铺汇总"
          @click="toAllPeriod"
        >
          全部
        </button>
      </div>
      <span class="wb-muted lg-sumview__hint">
        各店结余取自分摊行；公共池余额必须为 0，不为 0 说明有条目没摊出去
      </span>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error" data-act="summary-error">{{ error }}</p>

    <div v-if="loading" class="lg-hint" data-act="summary-loading">读取中…</div>

    <template v-else-if="data">
      <div class="wb-metabar lg-metabar">
        <span class="lg-metabar__month">{{ monthLabel }} · 全部店铺</span>
        <span class="wb-metric" data-act="summary-metric-income">总收入 <b>{{ money(data.incomeCents) }}</b></span>
        <span class="wb-metric" data-act="summary-metric-expense">总支出 <b>{{ money(data.expenseCents) }}</b></span>
        <span class="wb-metric" data-act="summary-metric-balance">结余 <b>{{ money(data.balanceCents) }}</b></span>
        <span class="wb-metric" data-act="summary-metric-entries">条目 <b>{{ data.entryCount }}</b></span>
      </div>

      <section class="wb-panel">
        <div class="wb-panel__head">
          <span>店铺汇总</span>
          <span class="wb-muted">{{ data.byShop.length }} 家店</span>
        </div>
        <div class="wb-panel__body wb-table-wrap">
          <table v-if="data.byShop.length" class="wb-table" data-act="summary-table">
            <thead>
              <tr>
                <th>店铺</th>
                <th class="wb-num">本店收入</th>
                <th class="wb-num">公摊收入</th>
                <th class="wb-num">本店支出</th>
                <th class="wb-num">公摊支出</th>
                <th class="wb-num">结余</th>
                <th class="wb-num lg-c-ratio" title="该店结余 / 所有店结余合计（合计为 0 时显示 —）">占结余合计</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in data.byShop" :key="r.shopId" :data-act="`summary-row-${r.shopId}`">
                <td>
                  {{ r.shopName || `店铺 #${r.shopId}` }}
                  <span v-if="r.shopStatus && r.shopStatus !== 'active'" class="wb-tag lg-tag">非营业</span>
                </td>
                <td class="wb-num">{{ money(r.directIncomeCents) }}</td>
                <td class="wb-num" :class="{ 'wb-muted': !r.sharedIncomeCents }">{{ money(r.sharedIncomeCents) }}</td>
                <td class="wb-num">{{ money(r.directExpenseCents) }}</td>
                <td class="wb-num" :class="{ 'wb-muted': !r.sharedExpenseCents }">{{ money(r.sharedExpenseCents) }}</td>
                <td class="wb-num lg-strong" :class="{ 'lg-amt--expense': r.balanceCents < 0 }">
                  {{ money(r.balanceCents) }}
                </td>
                <td class="wb-num wb-muted lg-c-ratio">{{ balanceShare(r.balanceCents) }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr class="lg-total">
                <td>合计</td>
                <td class="wb-num" data-act="summary-total-direct-income">{{ money(total.directIncome) }}</td>
                <td class="wb-num" data-act="summary-total-shared-income">{{ money(total.sharedIncome) }}</td>
                <td class="wb-num" data-act="summary-total-direct-expense">{{ money(total.directExpense) }}</td>
                <td class="wb-num" data-act="summary-total-shared-expense">{{ money(total.sharedExpense) }}</td>
                <td class="wb-num lg-strong" data-act="summary-total-balance" :class="{ 'lg-amt--expense': total.balance < 0 }">
                  {{ money(total.balance) }}
                </td>
                <td class="wb-num wb-muted">100.0%</td>
              </tr>
            </tfoot>
          </table>
          <div v-else class="lg-hint" data-act="summary-empty">
            {{ monthLabel }}还没有可按店铺归集的账目 —— 先记一笔本店或公共条目。
          </div>
        </div>
      </section>

      <div class="lg-checks">
        <section class="wb-panel" data-act="summary-public-pool">
          <div class="wb-panel__head">
            <span>公共池</span>
            <span class="wb-muted">本期公共条目 {{ data.sharedEntryCount }} 条</span>
          </div>
          <div class="wb-panel__body lg-check-body">
            <p v-if="poolOk" class="lg-check lg-check--ok" data-act="summary-public-status">
              ✓ 公共池余额 0 —— 公共条目已全部分摊到店铺
            </p>
            <template v-else>
              <p class="wb-notice wb-notice--error" data-act="summary-public-status">
                公共池余额 {{ money(data.integrity.publicPoolCents) }} —— 有条目的分摊与金额对不上，或没摊出去。
                这个数不为 0 时，上面的店铺汇总不能用来做决定。
              </p>
              <button class="wb-link" type="button" data-act="summary-drill-shared" @click="emit('drill-shared')">
                去看公共条目（切到明细并筛「范围 = 公共」）
              </button>
            </template>
          </div>
        </section>

        <section class="wb-panel" data-act="summary-integrity">
          <div class="wb-panel__head">
            <span>对账体检</span>
            <span class="wb-muted">正常时恒为 ✓</span>
          </div>
          <div class="wb-panel__body lg-check-body">
            <p class="lg-check" :class="partyOk ? 'lg-check--ok' : 'lg-check--bad'" data-act="summary-party-identity">
              <template v-if="partyOk">✓ Σ 相关人净往来 = 总收入 − 总支出</template>
              <template v-else>
                ✗ Σ 相关人净往来与「总收入 − 总支出」差 {{ money(data.integrity.partyGapCents) }} ——
                有条目挂在不存在的相关人上（下方列出）
              </template>
            </p>
            <p class="lg-check" :class="allocOk ? 'lg-check--ok' : 'lg-check--bad'" data-act="summary-allocation">
              <template v-if="allocOk">✓ 分摊合计 = 条目金额</template>
              <template v-else>
                ✗ 分摊合计比条目金额{{ data.integrity.allocationGapCents > 0 ? '多' : '少' }}
                {{ money(Math.abs(data.integrity.allocationGapCents)) }}
              </template>
            </p>
            <div v-if="data.integrity.missingPartyEntries.length" data-act="summary-missing-party">
              <p class="lg-check lg-check--bad">以下条目挂在不存在的相关人上（台账里会少这一笔）：</p>
              <ul class="lg-broken">
                <li v-for="b in data.integrity.missingPartyEntries" :key="b.entryId">
                  条目
                  <button class="wb-link wb-mono" type="button" data-act="summary-missing-open" @click="emit('open-entry', b.entryId)">
                    #{{ b.entryId }}
                  </button>
                  ：金额 {{ money(b.amountCents) }}
                </li>
              </ul>
            </div>

            <div v-if="data.integrity.brokenEntries.length" data-act="summary-broken">
              <p class="lg-check lg-check--bad">以下条目需要修复（点条目号直接打开对应条目）：</p>
              <ul class="lg-broken">
                <li v-for="b in data.integrity.brokenEntries" :key="b.entryId">
                  条目
                  <button class="wb-link wb-mono" type="button" data-act="summary-broken-open" @click="emit('open-entry', b.entryId)">
                    #{{ b.entryId }}
                  </button>
                  ：金额 {{ money(b.amountCents) }}，已摊 {{ money(b.allocatedCents) }}
                </li>
              </ul>
            </div>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// 「记账 › 汇总」（P4）。这里只有一个判据：**对平**。
//
//   各店结余合计 == 总收入 − 总支出（公共池余额恒 0）
//   Σ 相关人净往来 == 总收入 − 总支出
//   分摊合计 == 条目金额
//
// 三个数字分别来自 `ledgerSummary` 的三条体检（主进程算，不在渲染层重算 —— 否则"体检"变成
// "用同一套假设自证"）。任何一项非 0 都必须红字呈现，并给出能定位的入口，不允许静默吞掉。
import { computed, ref, watch } from 'vue';
import * as api from './api';
import { formatCents } from '@/lib/ledger';
import { localDayKey } from '@/lib/localDay';
import { ALL_PERIOD } from './useLedger';
import type { LedgerSummary } from '@/types';

const props = defineProps<{ month: string; monthLabel: string }>();

const emit = defineEmits<{
  'update:month': [value: string];
  'drill-shared': [];
  /** 体检定位：直接打开某条有问题的账（父层持有编辑弹层） */
  'open-entry': [entryId: number];
}>();

/** 全部日期：汇总本身是**累计**语义（各家店一共有多少收支），比按期相加更自然 */
const isAll = computed(() => props.month === ALL_PERIOD);

const data = ref<LedgerSummary | null>(null);
const loading = ref(false);
const error = ref('');

let reqToken = 0;

const total = computed(() => {
  const rows = data.value?.byShop ?? [];
  return rows.reduce(
    (acc, r) => ({
      directIncome: acc.directIncome + r.directIncomeCents,
      sharedIncome: acc.sharedIncome + r.sharedIncomeCents,
      directExpense: acc.directExpense + r.directExpenseCents,
      sharedExpense: acc.sharedExpense + r.sharedExpenseCents,
      balance: acc.balance + r.balanceCents,
    }),
    { directIncome: 0, sharedIncome: 0, directExpense: 0, sharedExpense: 0, balance: 0 }
  );
});

const poolOk = computed(() => (data.value?.integrity.publicPoolCents ?? 0) === 0);
const partyOk = computed(() => (data.value?.integrity.partyGapCents ?? 0) === 0);
const allocOk = computed(() => (data.value?.integrity.allocationGapCents ?? 0) === 0);

function money(cents: number): string {
  return cents < 0 ? `-¥${formatCents(-cents)}` : `¥${formatCents(cents)}`;
}

function balanceShare(cents: number): string {
  const sum = total.value.balance;
  if (!sum) return '—';
  return `${((cents / sum) * 100).toFixed(1)}%`;
}

function shiftMonth(delta: number): void {
  // 全部日期下按 ‹ › 等于"从本月开始翻"；不判就会 split 出 NaN（`NaN-NaN` 能通过任何存在性检查）
  const base = isAll.value ? localDayKey().slice(0, 7) : props.month;
  const [y, m] = base.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  emit('update:month', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
}

function toThisMonth(): void {
  emit('update:month', localDayKey().slice(0, 7));
}

function toAllPeriod(): void {
  emit('update:month', ALL_PERIOD);
}

async function refresh(): Promise<void> {
  const token = ++reqToken;
  loading.value = true;
  error.value = '';
  // 必须清空：不清的话新月份标题下会继续显示上个月的数（"数字对、期间错"最难发现，审查 P1-8）
  data.value = null;
  try {
    // 全部日期传 `''`（= 全期间汇总）；传 `all` 主进程会当成一个不存在的月份，返回全 0 且不报错
    const s = await api.summary(isAll.value ? '' : props.month);
    if (token === reqToken) data.value = s;
  } catch (e: unknown) {
    if (token === reqToken) {
      error.value = e instanceof Error ? e.message : String(e);
      data.value = null;
    }
  } finally {
    if (token === reqToken) loading.value = false;
  }
}

watch(() => props.month, () => void refresh(), { immediate: true });
</script>

<style scoped>
.lg-sumview {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
.lg-sumview__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.lg-sumview__hint {
  font-size: 12px;
}
.lg-month {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.lg-month__label {
  min-width: 96px;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}
.lg-month__all {
  margin-left: 2px;
  min-width: 44px;
  justify-content: center;
}
.lg-metabar {
  flex-shrink: 0;
}
.lg-metabar__month {
  padding-right: 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
  white-space: nowrap;
}
.lg-hint {
  padding: 28px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--wb-text-muted);
}
.lg-tag {
  margin-left: 6px;
}
.lg-c-ratio {
  width: 96px;
}
.lg-strong {
  font-weight: 600;
}
.lg-amt--expense {
  color: var(--wb-danger);
}
.lg-total td {
  font-weight: 600;
  background: var(--wb-surface-2);
}
.lg-checks {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 1100px) {
  .lg-checks {
    grid-template-columns: minmax(0, 1fr);
  }
}
.lg-check-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lg-check {
  margin: 0;
  font-size: 12.5px;
}
.lg-check--ok {
  color: var(--wb-success);
}
.lg-check--bad {
  color: var(--wb-danger);
}
.lg-broken {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--wb-text-muted);
}
</style>
