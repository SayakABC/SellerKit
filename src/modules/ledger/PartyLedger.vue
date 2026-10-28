<template>
  <div class="lg-parties">
    <p v-if="error" class="wb-notice wb-notice--error" data-act="party-ledger-error">
      {{ error }}（余额不可用，请勿据此结账）
      <button class="wb-btn wb-btn--sm" type="button" data-act="party-ledger-retry" @click="reload()">重试</button>
    </p>

    <p v-if="identityGap !== 0" class="wb-notice wb-notice--error" data-act="party-identity">
      往来对不上：Σ净往来 {{ money(sumNet) }}，但总收入 − 总支出 = {{ money(totalNet) }}（差
      {{ money(identityGap) }}）。先别按这些余额结账，请检查是否有条目没挂相关人。
    </p>
    <p v-else-if="loaded && identity" class="wb-notice wb-notice--ok lg-identity" data-act="party-identity">
      对账通过：Σ净往来 {{ money(sumNet) }} = 总收入 {{ money(identity.incomeCents) }} − 总支出
      {{ money(identity.expenseCents) }}
    </p>

    <section class="wb-panel lg-panel">
      <div class="wb-panel__head">
        <span>往来台账 · 累计</span>
        <span class="wb-muted">{{ visibleRows.length }} 人</span>
        <span class="lg-head__spacer"></span>
        <label class="lg-check">
          <input v-model="includeArchived" type="checkbox" data-act="party-include-archived" />
          含已停用
        </label>
      </div>

      <div class="wb-panel__body wb-table-wrap">
        <div v-if="loading" class="lg-hint">读取中…</div>

        <table v-else-if="visibleRows.length" class="wb-table lg-table" data-act="party-ledger-table">
          <thead>
            <tr>
              <th>相关人</th>
              <th class="lg-c-kind">类型</th>
              <th class="wb-num">应收</th>
              <th class="wb-num">应付</th>
              <th class="wb-num">净往来</th>
              <th class="wb-num">已结算</th>
              <th class="wb-num lg-c-unsettled">
                <button
                  class="wb-link"
                  type="button"
                  data-act="party-sort-unsettled"
                  :title="sortMode === 'abs-desc' ? '按未结清绝对值从大到小（当前）' : '按未结清绝对值从小到大'"
                  @click="toggleSort"
                >
                  未结清 {{ sortMode === 'abs-desc' ? '↓' : '↑' }}
                </button>
              </th>
              <th class="lg-c-date">最近结算</th>
              <th class="lg-c-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in visibleRows"
              :key="r.partyId"
              class="lg-row is-clickable"
              :data-party-ledger-id="r.partyId"
              tabindex="0"
              role="button"
              :aria-label="`打开 ${r.partyName} 的往来明细`"
              title="打开往来明细"
              @click="openDrawer(r.partyId)"
              @keydown.enter.prevent="openDrawer(r.partyId)"
              @keydown.space.prevent="openDrawer(r.partyId)"
            >
              <td class="wb-mono" data-act="ledger-party-name">
                {{ r.partyName }}
                <!-- 合并掉的与手动停用的必须分得开：前者有去处（能顺着找过去），后者只有自己 -->
                <span
                  v-if="r.archived && r.mergedTo"
                  class="wb-muted lg-archived"
                  data-act="ledger-party-merged"
                  :title="`已合并进「${nameOf(r.mergedTo)}」：未结算条目已改挂过去，已结算条目留在这个人名下`"
                >
                  已并入 → {{ nameOf(r.mergedTo) }}
                </span>
                <span v-else-if="r.archived" class="wb-muted lg-archived" data-act="ledger-party-archived">
                  已停用
                </span>
              </td>
              <td class="wb-muted">{{ PARTY_KIND_LABEL[r.kind] }}</td>
              <td class="wb-num" data-act="ledger-party-receivable">{{ money(r.receivableCents) }}</td>
              <td class="wb-num" data-act="ledger-party-payable">{{ money(r.payableCents) }}</td>
              <td
                class="wb-num"
                :class="r.netCents === 0 ? '' : r.netCents > 0 ? 'lg-amt--income' : 'lg-amt--expense'"
                data-act="ledger-party-net"
              >
                {{ money(r.netCents) }}
                <!-- 应收、应付都非 0 却抵消成 0：这时「0」不是"两清"，必须显式说一句（审查 P2-14） -->
                <span
                  v-if="r.netCents === 0 && (r.receivableCents > 0 || r.payableCents > 0)"
                  class="lg-dir"
                  title="应收与应付正好抵消，不是已结清"
                >
                  对冲
                </span>
              </td>
              <td class="wb-num" data-act="ledger-party-settled">{{ money(r.settledNetCents) }}</td>
              <td class="wb-num" data-act="ledger-party-unsettled">
                <span :class="r.unsettledCents === 0 ? 'wb-muted' : ''">{{ money(r.unsettledCents) }}</span>
                <span v-if="r.transferCents !== 0" class="lg-dir">
                  含承接 {{ money(r.transferCents) }}
                </span>
                <span class="lg-dir">
                  可收 {{ money(r.unsettledReceivableCents) }} · 可付 {{ money(r.unsettledPayableCents) }}
                </span>
              </td>
              <td class="wb-mono lg-nowrap" data-act="ledger-party-last-settle">
                {{ r.lastSettleDate || '—' }}
              </td>
              <td class="lg-c-ops">
                <button
                  class="wb-link"
                  type="button"
                  data-act="party-settle-open"
                  :disabled="!canSettleNow(r)"
                  :title="canSettleNow(r) ? '勾选未结条目生成结算单' : '这个人两个方向都没有未结清余额'"
                  @click.stop="openSettle(r)"
                >
                  结算
                </button>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="lg-total">
              <td colspan="2">合计（当前显示 {{ visibleRows.length }} 人）</td>
              <td class="wb-num" data-act="ledger-total-receivable">{{ money(totals.receivableCents) }}</td>
              <td class="wb-num" data-act="ledger-total-payable">{{ money(totals.payableCents) }}</td>
              <td class="wb-num" data-act="ledger-total-net">{{ money(totals.netCents) }}</td>
              <td class="wb-num" data-act="ledger-total-settled">{{ money(totals.settledNetCents) }}</td>
              <td class="wb-num" data-act="ledger-total-unsettled">{{ money(totals.unsettledCents) }}</td>
              <td colspan="2"></td>
            </tr>
          </tfoot>
        </table>

        <div v-else-if="loaded" class="wb-empty" data-act="party-ledger-empty">
          <div class="wb-empty__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M4 20V6a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
              <path d="M8 12h8M8 16h5" />
            </svg>
          </div>
          <p class="wb-empty__title">还没有往来</p>
          <p class="wb-empty__desc">
            每笔收支都要挂一个资金相关人；记过账之后，这里按人给出应收 / 应付 / 未结清，并可以生成结算单。
          </p>
          <div class="wb-empty__actions">
            <button class="wb-btn wb-btn--primary" type="button" data-act="party-ledger-manage" @click="emit('manage')">
              管理相关人
            </button>
          </div>
        </div>
      </div>

      <div class="wb-panel__foot lg-foot">
        <span class="wb-muted">
          「未结清」= 净往来 + 已结算；负数 = 我欠对方。<b>0 不等于已结清</b> —— 可收与可付正好抵消时也是 0，
          请看每行的「可收 / 可付」或点开逐笔明细。点任一行看逐笔明细。
        </span>
      </div>
    </section>

    <PartyDrawer
      v-if="drawerId"
      :party-id="drawerId"
      @close="drawerId = 0"
      @changed="onChanged"
    />

    <SettlementDialog
      v-if="settleTarget"
      :party-id="settleTarget.partyId"
      :party-name="settleTarget.partyName"
      :balance="settleTarget"
      @close="settleTarget = null"
      @done="onSettled"
    />
  </div>
</template>

<script setup lang="ts">
// 「记账 › 往来」（P3）。这一页只回答一个问题：**我跟他之间还差多少钱、现在结掉哪几笔**。
//
// 三条不能省的显示：
//   ① 六个数（应收 / 应付 / 净往来 / 已结算 / 未结清 / 分方向余额）—— 少一个用户就得自己减，
//      而他减出来的口径不一定与系统一致（方案 §6.2）；
//   ② 合计行要跟着"当前显示"走，并与累计对账恒等式分开：前者是筛选视图，后者是全量事实；
//   ③ 对账通过也要写出来（不是只报错）—— 用户需要知道"这些数能拿来结账"。
import { computed, onMounted, ref } from 'vue';
import PartyDrawer from './PartyDrawer.vue';
import SettlementDialog from './SettlementDialog.vue';
import * as api from './api';
import { PARTY_KIND_LABEL } from './labels';
import { formatCents } from '@/lib/ledger';
import type { LedgerPartyLedgerRow, LedgerSummary } from '@/types';

const emit = defineEmits<{ changed: []; manage: [] }>();

const allRows = ref<LedgerPartyLedgerRow[]>([]);
const identity = ref<LedgerSummary | null>(null);
const loading = ref(false);
const loaded = ref(false);
const error = ref('');
const includeArchived = ref(false);
const sortMode = ref<'abs-desc' | 'abs-asc'>('abs-desc');
const drawerId = ref(0);
const settleTarget = ref<LedgerPartyLedgerRow | null>(null);

function money(cents: number): string {
  return cents < 0 ? `-¥${formatCents(-cents)}` : `¥${formatCents(cents)}`;
}

/**
 * 「并入到谁」只做展示查询。`allRows` 是全量（含已停用），正常一定能命中；
 * 命中不到就退回 id —— 绝不因为查不到名字而把它显示成「已停用」，那正是这次要消掉的歧义。
 */
function nameOf(partyId: number): string {
  const hit = allRows.value.find((r) => r.partyId === partyId);
  return hit ? hit.partyName : `#${partyId}`;
}

const visibleRows = computed(() => {
  const rows = includeArchived.value ? allRows.value : allRows.value.filter((r) => !r.archived);
  const dir = sortMode.value === 'abs-desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const diff = Math.abs(a.unsettledCents) - Math.abs(b.unsettledCents);
    if (diff !== 0) return diff * dir;
    return a.partyId - b.partyId;
  });
});

const totals = computed(() =>
  visibleRows.value.reduce(
    (acc, r) => ({
      receivableCents: acc.receivableCents + r.receivableCents,
      payableCents: acc.payableCents + r.payableCents,
      netCents: acc.netCents + r.netCents,
      settledNetCents: acc.settledNetCents + r.settledNetCents,
      unsettledCents: acc.unsettledCents + r.unsettledCents,
    }),
    { receivableCents: 0, payableCents: 0, netCents: 0, settledNetCents: 0, unsettledCents: 0 }
  )
);

/** 恒等式按**全量**算（含已停用）：筛选只是视图，不能改变"总账对不对"这个事实 */
const sumNet = computed(() => allRows.value.reduce((s, r) => s + r.netCents, 0));
const totalNet = computed(
  () => (identity.value?.incomeCents ?? 0) - (identity.value?.expenseCents ?? 0)
);
const identityGap = computed(() => sumNet.value - totalNet.value);

function canSettleNow(r: LedgerPartyLedgerRow): boolean {
  return r.unsettledPayableCents > 0 || r.unsettledReceivableCents > 0;
}

function toggleSort(): void {
  sortMode.value = sortMode.value === 'abs-desc' ? 'abs-asc' : 'abs-desc';
}

function openDrawer(partyId: number): void {
  drawerId.value = partyId;
}

function openSettle(r: LedgerPartyLedgerRow): void {
  settleTarget.value = r;
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [rows, sum] = await Promise.all([api.partyLedger({ includeArchived: true }), api.summaryAll()]);
    allRows.value = rows;
    identity.value = sum;
    loaded.value = true;
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
    allRows.value = [];
    identity.value = null;
    // 必须复位：否则恒等式块会用"空数组算出的 0"渲染出「对账通过 ¥0.00 = ¥0.00 − ¥0.00」，
    // 而这条横幅是"数能不能拿去结账"的唯一门禁（审查 P0-2）
    loaded.value = false;
  } finally {
    loading.value = false;
  }
}

async function onSettled(): Promise<void> {
  settleTarget.value = null;
  await onChanged();
}

async function onChanged(): Promise<void> {
  await reload();
  emit('changed');
}

onMounted(() => void reload());

defineExpose({ reload });
</script>

<style scoped>
.lg-parties {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
.lg-identity {
  flex-shrink: 0;
}
.lg-head__spacer {
  flex: 1;
}
.lg-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.lg-check input {
  accent-color: var(--wb-primary);
}
.lg-c-kind {
  width: 80px;
}
.lg-c-unsettled {
  min-width: 170px;
}
.lg-c-date {
  width: 108px;
}
.lg-c-ops {
  width: 72px;
}
.lg-dir {
  display: block;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--wb-text-muted);
  white-space: nowrap;
}
.lg-archived {
  margin-left: 4px;
  font-size: 11.5px;
}
.lg-amt--income {
  color: var(--wb-success);
}
.lg-amt--expense {
  color: var(--wb-danger);
}
.lg-total td {
  font-weight: 600;
  background: var(--wb-surface-2);
}
.lg-hint {
  padding: 28px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--wb-text-muted);
}
.lg-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12.5px;
}
</style>
