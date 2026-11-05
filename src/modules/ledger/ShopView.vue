<template>
  <div class="lg-shop" data-act="shop-view">
    <div class="lg-shop__bar">
      <div class="lg-month">
        <button class="wb-btn wb-btn--sm" type="button" data-act="shop-month-prev" aria-label="上个月" @click="shiftMonth(-1)">
          ‹
        </button>
        <button
          class="wb-btn wb-btn--sm lg-month__label"
          type="button"
          data-act="shop-month-now"
          title="回到本月"
          @click="toThisMonth"
        >
          {{ monthLabel }}
        </button>
        <button class="wb-btn wb-btn--sm" type="button" data-act="shop-month-next" aria-label="下个月" @click="shiftMonth(1)">
          ›
        </button>
        <button
          class="wb-btn wb-btn--sm lg-month__all"
          type="button"
          data-act="shop-month-all"
          :class="{ 'is-on': isAll }"
          :aria-pressed="isAll"
          title="不限月份：看这家店全部日期的账"
          @click="toAllPeriod"
        >
          全部
        </button>
      </div>

      <select
        class="wb-input wb-input--sm lg-shop__pick"
        data-act="shop-pick"
        aria-label="选择店铺"
        :value="Number(shopId) || 0"
        @change="onShopPick"
      >
        <option :value="0">选择店铺…</option>
        <option v-for="s in shops" :key="s.id" :value="s.id">{{ s.name }}</option>
        <!-- 记忆里的店已不在列表（被删/归档）：补一个占位，否则下拉显示"选择店铺…"而数据区是那家店 -->
        <option v-if="missingShop" :value="Number(shopId)">#{{ shopId }}（已不在店铺列表）</option>
      </select>

      <span class="wb-muted lg-shop__hint">
        口径：本店条目 + 摊到本店的公共条目；结算进度不影响这页任何数字
      </span>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error" data-act="shop-error">{{ error }}</p>

    <div v-if="!shopId" class="wb-empty" data-act="shop-empty">
      <div class="wb-empty__icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M3 9.5 12 4l9 5.5V20H3V9.5Z" />
          <path d="M9 20v-6h6v6" />
        </svg>
      </div>
      <p class="wb-empty__title">先选一家店</p>
      <p class="wb-empty__desc">
        选店之后，这里给出这家店{{ periodWord }}的收入、支出、结余，以及每一笔公共开支摊到它头上的金额。
      </p>
    </div>

    <div v-else-if="loading && !data" class="lg-hint" data-act="shop-loading">读取中…</div>

    <template v-else-if="data">
      <div class="lg-shop__head">
        <span class="lg-shop__name">{{ data.shopName || `店铺 #${data.shopId}` }}</span>
        <span v-if="statusLabel" class="wb-tag">{{ statusLabel }}</span>
        <span class="wb-muted">{{ monthLabel }}</span>
      </div>

      <div class="lg-cards">
        <div class="lg-card" data-act="shop-card-income">
          <span class="lg-card__label">收入</span>
          <span class="lg-card__value lg-card__value--income">{{ money(data.incomeCents) }}</span>
          <span class="lg-card__sub">
            本店 {{ money(data.directIncomeCents) }} · 公摊 {{ money(data.sharedIncomeCents) }}
          </span>
        </div>
        <div class="lg-card" data-act="shop-card-expense">
          <span class="lg-card__label">支出</span>
          <span class="lg-card__value lg-card__value--expense">{{ money(data.expenseCents) }}</span>
          <span class="lg-card__sub">
            本店 {{ money(data.directExpenseCents) }} · 公摊 {{ money(data.sharedExpenseCents) }}
          </span>
        </div>
        <div class="lg-card" data-act="shop-card-balance">
          <span class="lg-card__label">结余</span>
          <span class="lg-card__value" :class="{ 'lg-card__value--expense': data.balanceCents < 0 }">
            {{ money(data.balanceCents) }}
          </span>
          <span class="lg-card__sub">收入 − 支出</span>
        </div>
      </div>

      <div class="lg-shop__grid">
        <section class="wb-panel">
          <div class="wb-panel__head">
            <span>科目分布</span>
            <span class="wb-muted">{{ data.byCategory.length }} 个科目</span>
          </div>
          <div class="wb-panel__body wb-table-wrap">
            <table v-if="data.byCategory.length" class="wb-table" data-act="shop-categories">
              <thead>
                <tr>
                  <th>收/支</th>
                  <th>科目</th>
                  <th class="wb-num">本店</th>
                  <th class="wb-num">公摊</th>
                  <th class="wb-num">合计</th>
                  <th class="wb-num lg-c-ratio">占该方向</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="c in data.byCategory"
                  :key="`${c.kind}-${c.categoryId}`"
                  :data-act="`shop-cat-${c.kind}-${c.categoryId}`"
                >
                  <td>
                    <span class="wb-tag" :class="{ 'is-on': c.kind === 'income' }">{{ KIND_LABEL[c.kind] }}</span>
                  </td>
                  <td>{{ c.categoryName || '未分类' }}</td>
                  <td class="wb-num">{{ money(c.directCents) }}</td>
                  <td class="wb-num" :class="{ 'wb-muted': !c.sharedCents }">{{ money(c.sharedCents) }}</td>
                  <td class="wb-num lg-strong">{{ money(c.amountCents) }}</td>
                  <td class="wb-num wb-muted lg-c-ratio">{{ ratioText(c) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="lg-hint" data-act="shop-cat-empty">这家店{{ periodWord }}还没有本店账目，也没有摊到公共条目。</div>
          </div>
        </section>

        <section class="wb-panel">
          <div class="wb-panel__head">
            <span>本店承担的公摊</span>
            <span class="wb-muted">{{ data.sharedEntries.length }} 笔</span>
          </div>
          <div class="wb-panel__body wb-table-wrap">
            <table v-if="data.sharedEntries.length" class="wb-table" data-act="shop-shared">
              <thead>
                <tr>
                  <th class="lg-c-date">日期</th>
                  <th>科目</th>
                  <th class="wb-num">整笔</th>
                  <th class="wb-num">本店摊入</th>
                  <th class="wb-num lg-c-ratio">占比</th>
                  <th>相关人</th>
                  <th class="lg-c-note">备注</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in data.sharedEntries" :key="s.entryId" :data-act="`shop-shared-${s.entryId}`">
                  <td class="wb-mono lg-nowrap">{{ s.bizDate }}</td>
                  <td>{{ s.categoryName || '未分类' }}</td>
                  <td class="wb-num">{{ money(s.entryCents) }}</td>
                  <td class="wb-num lg-strong" :class="s.kind === 'income' ? 'lg-amt--income' : 'lg-amt--expense'">
                    {{ money(s.amountCents) }}
                  </td>
                  <td class="wb-num wb-muted lg-c-ratio">{{ (s.ratioBp / 100).toFixed(2) }}%</td>
                  <td>{{ s.partyName || '—' }}</td>
                  <td class="lg-c-note">
                    <span v-if="s.note" class="lg-note" :title="s.note">{{ s.note }}</span>
                    <span v-else class="wb-muted">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="lg-hint" data-act="shop-shared-empty">{{ periodWord }}没有公共条目摊到这家店。</div>
          </div>
        </section>
      </div>

      <section class="wb-panel" data-act="shop-compare">
        <div class="wb-panel__head">
          <span>与统计口径对照（只读）</span>
          <span v-if="revLoading" class="wb-muted">订单收入读取中…</span>
        </div>
        <div class="wb-panel__body">
          <p v-if="isAll" class="wb-field__hint" data-act="shop-compare-all">
            全部日期下不做订单收入对照：订单是按月取数的，跨月会撞上取数上限，算出来的只是下限 ——
            拿它跟记账收入比会得出"记账比订单多"这种错误结论。要看对照请选一个具体月份。
          </p>
          <div class="lg-compare">
            <div class="lg-compare__item">
              <span class="lg-compare__label">记账收入（{{ periodWord }}）</span>
              <span class="lg-compare__value" data-act="shop-compare-ledger">{{ money(data.incomeCents) }}</span>
            </div>
            <div class="lg-compare__item">
              <span class="lg-compare__label">订单收入（{{ periodWord }} · 统计口径）</span>
              <span v-if="revError" class="lg-compare__value wb-muted" data-act="shop-compare-error">
                读取失败：{{ revError }}
              </span>
              <span v-else class="lg-compare__value" data-act="shop-compare-orders">
                {{ rev ? money(rev.byShopId[shopId] ?? 0) : '—' }}
              </span>
            </div>
            <div class="lg-compare__item">
              <span class="lg-compare__label">差异（记账 − 订单）</span>
              <span class="lg-compare__value" data-act="shop-compare-diff">
                {{ diffCents === null ? '—' : money(diffCents) }}
              </span>
            </div>
          </div>
          <p class="wb-field__hint" data-act="shop-compare-note">
            差异来自未到账订单、退款、平台扣费与手工未录，本页不做归因，也不做「以谁为准」的裁定 —— 两个口径不可相加。
          </p>
          <p v-if="rev?.truncated" class="wb-notice wb-notice--warn">
            订单行已达取数上限（{{ ORDER_LIMIT }} 行），订单收入只是下限，不能拿来对这个差异下结论。
          </p>
          <p v-if="revUnmatchedCents > 0" class="wb-notice wb-notice--warn">
            另有 {{ money(revUnmatchedCents) }} 订单营收未能归属到任何店铺（未登记 / 同名多店），未计入上面一列。
          </p>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
// 「记账 › 单店」（P4）。三个数来自**分摊行**（`bk_allocations`）：专属条目也有自己的一行全额分摊，
// 所以「收入 = 专属 + 公摊」与汇总页 byShop 是同一套口径（方案 §7.1）。
//
// 与统计页的对照是**只读并排**：两个口径不能相加，也不在本页做归因（方案 §1.3 第 1 条、§7.3）。
// 营收仍走 `ledgerRevenue`（RK-06 复用统计页那套 computeOrderCosts），不另写一条收入 SQL。
import { computed, ref, watch } from 'vue';
import * as api from './api';
import { KIND_LABEL } from './labels';
import { formatCents } from '@/lib/ledger';
import { revenueByShopId, type LedgerRevenue } from '@/lib/ledgerRevenue';
import { localDayKey } from '@/lib/localDay';
import { ALL_PERIOD } from './useLedger';
import type { LedgerShopBreakdown, LedgerShopBreakdownCategoryRow, ShopListItem } from '@/types';

/** 与 `api.monthOrderRows` 的默认 limit 对齐；触达即视为不完整（见 ledgerRevenue.truncated） */
const ORDER_LIMIT = 2000;

const props = defineProps<{
  month: string;
  monthLabel: string;
  shops: ShopListItem[];
  shopId: number;
}>();

const emit = defineEmits<{
  'update:month': [value: string];
  'update:shopId': [value: number];
}>();

const data = ref<LedgerShopBreakdown | null>(null);
const loading = ref(false);
const error = ref('');

/** 记忆里的店不在下拉里（被删/归档）时，`select` 需要一个占位项，否则会显示"选择店铺…" */
const missingShop = computed(() => {
  const id = Number(props.shopId) || 0;
  return id > 0 && !props.shops.some((s) => s.id === id);
});
const rev = ref<LedgerRevenue | null>(null);
const revLoading = ref(false);
const revError = ref('');

/** 切店/切月很快时，先发出的请求可能后回来 —— 只认最后一次 */
let reqToken = 0;

/**
 * 「全部日期」下本页的收支、科目分布、公摊明细都能算（都是全期间求和，语义成立），
 * 唯一不能算的是**订单收入对照**：`orderShippingRows` 是按月拉的，跨月必然撞上取数上限，
 * 算出来的订单收入只是下限 —— 拿它去对照会得出"记账比订单多"这种完全错误的结论。
 * 所以全部日期下不取订单、两项显示 "—" 并说明原因。
 */
const isAll = computed(() => props.month === ALL_PERIOD);
/** 文案里的期间词：全部日期下再说"本月"就是错的 */
const periodWord = computed(() => (isAll.value ? '全部日期' : '本月'));

const SHOP_STATUS_LABEL: Record<string, string> = {
  active: '',
  paused: '暂停',
  banned: '封禁',
  closed: '已关闭',
  archived: '已停用',
};

const statusLabel = computed(() => SHOP_STATUS_LABEL[String(data.value?.shopStatus ?? '')] ?? data.value?.shopStatus ?? '');

const diffCents = computed<number | null>(() => {
  if (!data.value || !rev.value) return null;
  return data.value.incomeCents - (rev.value.byShopId[props.shopId] ?? 0);
});

const revUnmatchedCents = computed(() => rev.value?.unmatchedTotalCents ?? 0);

function money(cents: number): string {
  return cents < 0 ? `-¥${formatCents(-cents)}` : `¥${formatCents(cents)}`;
}

/** 占比按**同方向**（收入占收入、支出占支出）—— 混在一起算出来的百分比没有业务含义 */
function ratioText(row: LedgerShopBreakdownCategoryRow): string {
  const total = (data.value?.byCategory ?? [])
    .filter((c) => c.kind === row.kind)
    .reduce((sum, c) => sum + c.amountCents, 0);
  if (!total) return '—';
  return `${((row.amountCents / total) * 100).toFixed(1)}%`;
}

function shiftMonth(delta: number): void {
  // 全部日期下按 ‹ › 等于"从本月开始翻"；不判就会 split 出 NaN，`NaN-NaN` 是合法字符串
  const base = isAll.value ? localDayKey().slice(0, 7) : props.month;
  const [y, m] = base.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  emit('update:month', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
}

function toThisMonth(): void {
  emit('update:month', localDayKey().slice(0, 7));
}

/** 与上/下月同一入口：父层的 `setMonth` 认 `all`（见 LedgerView） */
function toAllPeriod(): void {
  emit('update:month', ALL_PERIOD);
}

function onShopPick(e: Event): void {
  const id = Number((e.target as HTMLSelectElement).value) || 0;
  emit('update:shopId', id);
}

async function refresh(): Promise<void> {
  const id = Number(props.shopId) || 0;
  const period = props.month;
  const token = ++reqToken;

  data.value = null;
  error.value = '';
  rev.value = null;
  revError.value = '';
  revLoading.value = false;
  loading.value = false;
  if (!id) return;

  loading.value = true;
  try {
    // 全部日期 = 不传 period（主进程见空即不过滤）；传 `all` 会查不到任何行且**不报错**
    const d = await api.shopBreakdown({ shopId: id, period: isAll.value ? undefined : period });
    if (token === reqToken) data.value = d;
  } catch (e: unknown) {
    if (token === reqToken) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (token === reqToken) loading.value = false;
  }
  if (token !== reqToken) return;

  if (isAll.value) return; // 见 `isAll` 注释：跨月的订单收入不可用，不取

  revLoading.value = true;
  try {
    const orders = await api.monthOrderRows(period, ORDER_LIMIT);
    if (token !== reqToken) return;
    rev.value = revenueByShopId({ orders, shops: props.shops, truncated: orders.length >= ORDER_LIMIT });
  } catch (e: unknown) {
    if (token === reqToken) revError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (token === reqToken) revLoading.value = false;
  }
}

watch(
  () => [props.shopId, props.month, props.shops.length] as const,
  () => void refresh(),
  { immediate: true }
);
</script>

<style scoped>
.lg-shop {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
.lg-shop__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
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
.lg-shop__pick {
  min-width: 200px;
}
.lg-shop__hint {
  font-size: 12px;
}
.lg-shop__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.lg-shop__name {
  font-size: 15px;
  font-weight: 600;
  color: var(--wb-text);
}

.lg-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  flex-shrink: 0;
}
.lg-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
}
.lg-card__label {
  font-size: 12px;
  color: var(--wb-text-muted);
}
.lg-card__value {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--wb-text);
}
.lg-card__value--income {
  color: var(--wb-success);
}
.lg-card__value--expense {
  color: var(--wb-danger);
}
.lg-card__sub {
  font-size: 12px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}

.lg-shop__grid {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 12px;
  min-height: 0;
}
@media (max-width: 1100px) {
  .lg-shop__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.lg-hint {
  padding: 24px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--wb-text-muted);
}
.lg-c-date {
  width: 96px;
}
.lg-c-ratio {
  width: 88px;
}
.lg-c-note {
  max-width: 200px;
}
.lg-note {
  display: inline-block;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}
.lg-nowrap {
  white-space: nowrap;
}
.lg-strong {
  font-weight: 600;
}
.lg-amt--income {
  color: var(--wb-success);
}
.lg-amt--expense {
  color: var(--wb-danger);
}

.lg-compare {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.lg-compare__item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}
.lg-compare__label {
  font-size: 12px;
  color: var(--wb-text-muted);
}
.lg-compare__value {
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--wb-text);
}
</style>
