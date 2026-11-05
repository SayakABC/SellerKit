<template>
  <div class="wb-mask" @click.self="close">
    <aside class="wb-drawer lg-drawer" role="dialog" aria-modal="true" data-act="party-drawer">
      <div class="wb-dialog__head">
        <span data-act="drawer-title">{{ ledger?.partyName || `相关人 #${partyId}` }}</span>
        <span class="wb-muted lg-head__kind">{{ ledger ? PARTY_KIND_LABEL[ledger.kind] : '' }}</span>
        <span v-if="ledger?.archived" class="wb-tag">已停用</span>
        <span class="lg-head__spacer"></span>
        <button class="wb-link" type="button" data-act="drawer-close" @click="close">关闭</button>
      </div>

      <div class="wb-dialog__body">
        <p v-if="error" class="wb-notice wb-notice--error" data-act="drawer-error">{{ error }}</p>
        <div v-if="loading" class="lg-hint">读取中…</div>

        <template v-else-if="ledger">
          <!-- 六个数：少一个用户就得自己减，而他自己减出来的口径不一定与系统一致 -->
          <div class="lg-nums" data-act="drawer-numbers">
            <div class="lg-num">
              <span class="lg-num__label">应收</span>
              <b class="lg-num__value">{{ money(ledger.receivableCents) }}</b>
            </div>
            <div class="lg-num">
              <span class="lg-num__label">应付</span>
              <b class="lg-num__value">{{ money(ledger.payableCents) }}</b>
            </div>
            <div class="lg-num">
              <span class="lg-num__label">净往来</span>
              <b class="lg-num__value" :class="netClass(ledger.netCents)">{{ money(ledger.netCents) }}</b>
            </div>
            <div class="lg-num">
              <span class="lg-num__label">已结算</span>
              <b class="lg-num__value">{{ money(ledger.settledNetCents) }}</b>
            </div>
            <div class="lg-num">
              <span class="lg-num__label">未结清</span>
              <b class="lg-num__value" :class="netClass(ledger.unsettledCents)">
                {{ money(ledger.unsettledCents) }}
              </b>
            </div>
            <div class="lg-num">
              <span class="lg-num__label">分方向</span>
              <b class="lg-num__value lg-num__value--sm">
                可收 {{ money(ledger.unsettledReceivableCents) }} · 可付
                {{ money(ledger.unsettledPayableCents) }}
              </b>
            </div>
          </div>

          <p v-if="ledger.transferCents !== 0" class="wb-notice wb-notice--warn" data-act="drawer-transfer">
            另有相关人合并承接的余额 {{ money(ledger.transferCents) }}（不在下方逐笔明细里）。
          </p>

          <section class="lg-sec">
            <div class="lg-sec__head">
              <span>逐笔明细</span>
              <span class="wb-muted">按日期倒序，余额 = 截至该笔之后的未结清</span>
            </div>
            <p v-if="entries.length >= 1000" class="wb-notice wb-notice--warn" data-act="drawer-truncated">
              只取了最近 1000 条：余额从最早可见那一行开始起算，不是这个人账户的起点。
            </p>
            <table v-if="timeline.length" class="wb-table lg-timeline" data-act="drawer-timeline">
              <thead>
                <tr>
                  <th class="lg-c-date">日期</th>
                  <th class="lg-c-type">类型</th>
                  <th>摘要</th>
                  <th class="wb-num">金额</th>
                  <th class="wb-num">余额</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in timeline"
                  :key="row.key"
                  :class="{ 'is-void': row.status === 'void' }"
                  :data-drawer-row="row.key"
                >
                  <td class="wb-mono lg-nowrap">{{ row.date }}</td>
                  <td>
                    <span class="wb-tag" :class="{ 'is-on': row.settled }">{{ row.typeLabel }}</span>
                  </td>
                  <td class="lg-c-summary" :title="row.summary">{{ row.summary }}</td>
                  <td class="wb-num" :class="row.kind === 'income' ? 'lg-amt--income' : row.kind === 'expense' ? 'lg-amt--expense' : ''">
                    {{ row.sign }}{{ money(row.amountCents) }}
                  </td>
                  <td class="wb-num">{{ money(row.balanceCents) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="wb-empty">
              <p class="wb-empty__title">还没有逐笔记录</p>
              <p class="wb-empty__desc">这个人名下的收支与结算记录会按日期出现在这里。</p>
            </div>
          </section>

          <section class="lg-sec">
            <div class="lg-sec__head">
              <span>结算单</span>
              <span class="wb-muted">{{ settlements.length }} 张（含已撤销）</span>
            </div>
            <table v-if="settlements.length" class="wb-table lg-settles" data-act="drawer-settlements">
              <thead>
                <tr>
                  <th class="lg-c-date">日期</th>
                  <th>方向</th>
                  <th class="wb-num">金额</th>
                  <th>方式</th>
                  <th class="lg-c-state">状态</th>
                  <th class="lg-c-ops">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="s in settlements"
                  :key="s.id"
                  :class="{ 'is-void': s.status === 'void' }"
                  :data-settlement-id="s.id"
                >
                  <td class="wb-mono lg-nowrap">{{ s.settleDate }}</td>
                  <td>{{ SETTLE_DIRECTION_LABEL[s.direction] }}</td>
                  <td class="wb-num" :data-settle-cash="s.cashCents">
                    <template v-if="s.direction === 'offset'">
                      <b>{{ cashLabel(s) }}</b>
                      <span class="lg-dir">抵 {{ money(s.amountCents) }}</span>
                    </template>
                    <template v-else>{{ money(s.amountCents) }}</template>
                  </td>
                  <td :class="{ 'wb-muted': !s.method }">{{ s.method || '—' }}</td>
                  <td class="lg-c-state">
                    <span v-if="s.status === 'void'" class="wb-tag" :title="s.voidReason">
                      已撤销：{{ s.voidReason || '—' }}
                    </span>
                    <span v-else class="wb-tag is-on">有效 · {{ s.entryCount }} 条</span>
                  </td>
                  <td class="lg-c-ops">
                    <button
                      v-if="s.status === 'active'"
                      class="wb-link wb-link--danger"
                      type="button"
                      data-act="settle-void-open"
                      @click="askVoid(s)"
                    >
                      撤销
                    </button>
                    <span v-else class="wb-muted">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-else class="wb-field__hint">还没有结算过。</p>
          </section>
        </template>
      </div>

      <div class="wb-dialog__foot">
        <button class="wb-btn" type="button" data-act="drawer-foot-close" @click="close">关闭</button>
        <button
          class="wb-btn"
          type="button"
          data-act="drawer-repatch"
          :disabled="!unsettledIds.length || repatchBusy"
          :title="
            unsettledIds.length
              ? `把这个人名下 ${unsettledIds.length} 条未结算条目改挂给别的相关人`
              : '没有未结算条目；已结算的要先撤销结算（在编辑这笔账里点「变更相关人…」）'
          "
          @click="openRepatch"
        >
          变更相关人{{ unsettledIds.length ? `（未结 ${unsettledIds.length} 条）` : '' }}
        </button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="drawer-settle"
          :disabled="!canSettleNow"
          :title="canSettleNow ? '勾选未结条目生成结算单' : '两个方向都没有未结清余额'"
          @click="settleOpen = true"
        >
          结算未结条目
        </button>
      </div>
    </aside>

    <SettlementDialog
      v-if="settleOpen && ledger"
      :party-id="ledger.partyId"
      :party-name="ledger.partyName"
      :balance="ledger"
      @close="settleOpen = false"
      @done="onSettled"
    />

    <ConfirmDialog
      v-if="pendingVoid"
      title="撤销结算"
      confirm-text="确认撤销"
      busy-text="撤销中…"
      :busy="voidBusy"
      danger
      @close="pendingVoid = null"
      @confirm="confirmVoid"
    >
      <p>
        撤销结算单 #{{ pendingVoid.id }}（{{ pendingVoid.settleDate }} ·
        {{ SETTLE_DIRECTION_LABEL[pendingVoid.direction] }} ·
        <b class="wb-mono">{{ cashLabel(pendingVoid) }}</b>）。
      </p>
      <p v-if="pendingVoid.direction === 'offset'" class="wb-field__hint">
        这张是互抵单：毛额 {{ money(pendingVoid.amountCents) }}（抵掉支出
        {{ money(pendingVoid.payCents) }}、收入 {{ money(pendingVoid.receiveCents) }}）。
        撤销后两边条目一起恢复为未结算。
      </p>
      <p class="wb-field__hint">
        撤销不删记录：结算单留在列表里（标「已撤销」），这 {{ pendingVoid.entryCount }} 条条目恢复为未结算，可重新结算。
      </p>
      <label class="wb-field">
        <span class="wb-field__label">撤销原因 <i class="wb-field__req">*</i></span>
        <textarea
          v-model="voidReason"
          class="wb-input"
          rows="2"
          data-act="settle-void-reason"
          placeholder="如：这笔结错了人，需重新结算"
        ></textarea>
      </label>
      <p v-if="voidError" class="wb-notice wb-notice--error">{{ voidError }}</p>
    </ConfirmDialog>

    <RepatchDialog
      v-if="repatchOpen"
      :entry-ids="repatchIds"
      :parties="repatchParties"
      @close="repatchOpen = false"
      @done="onRepatched"
    />
  </div>
</template>

<script setup lang="ts">
// 「往来 › 抽屉」（P3）：把"这个人跟我的每一笔"按日期摊开，并给出结算入口。
//
// 余额列由纯函数 `runningUnsettled` 算（与 `partyBalance` 同一套符号），
// 不在组件里另写一遍加减 —— 否则抽屉余额与顶部「未结清」迟早对不上。
import { computed, onMounted, ref } from 'vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import SettlementDialog from './SettlementDialog.vue';
import RepatchDialog from './RepatchDialog.vue';
import * as api from './api';
import { KIND_LABEL, PARTY_KIND_LABEL, SETTLE_DIRECTION_LABEL } from './labels';
import { formatCents } from '@/lib/ledger';
import { runningUnsettled, type PartyTimelineEvent } from '@/lib/partyLedger';
import { toast } from '@/core/services/toast';
import type {
  LedgerEntryRow,
  LedgerPartyLedgerRow,
  LedgerPartyRow,
  LedgerSettlementRow,
} from '@/types';

const props = defineProps<{ partyId: number }>();
const emit = defineEmits<{ close: []; changed: [] }>();

const ledger = ref<LedgerPartyLedgerRow | null>(null);
const entries = ref<LedgerEntryRow[]>([]);
const settlements = ref<LedgerSettlementRow[]>([]);
const loading = ref(false);
const error = ref('');

const settleOpen = ref(false);
const pendingVoid = ref<LedgerSettlementRow | null>(null);
const voidReason = ref('');
const voidError = ref('');
const voidBusy = ref(false);

/** 变更相关人（方案 §8.3 要求抽屉里就有入口）：默认把这个人名下**未结算**的条目一起改挂 */
const repatchOpen = ref(false);
const repatchIds = ref<number[]>([]);
const repatchParties = ref<LedgerPartyRow[]>([]);
const repatchBusy = ref(false);

const unsettledIds = computed(() =>
  entries.value.filter((e) => e.status === 'active' && !e.settled).map((e) => e.id)
);

async function openRepatch(): Promise<void> {
  if (!unsettledIds.value.length || repatchBusy.value) return;
  repatchBusy.value = true;
  try {
    // 相关人列表按需取：抽屉本身不需要它，只有这里用
    repatchParties.value = await api.parties(true);
    repatchIds.value = unsettledIds.value;
    repatchOpen.value = true;
  } catch (e: unknown) {
    toast(`读取相关人失败：${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    repatchBusy.value = false;
  }
}

async function onRepatched(): Promise<void> {
  repatchOpen.value = false;
  await load();
  emit('changed');
}

function money(cents: number): string {
  return cents < 0 ? `-¥${formatCents(-cents)}` : `¥${formatCents(cents)}`;
}

function netClass(cents: number): string {
  if (cents === 0) return '';
  return cents > 0 ? 'lg-amt--income' : 'lg-amt--expense';
}

/** 互抵单的**实际资金流**文案：毛额看不出到底给没给钱，必须把净额单独写出来 */
function cashLabel(s: LedgerSettlementRow): string {
  if (s.direction !== 'offset') return money(s.amountCents);
  if (s.cashCents === 0) return '¥0（完全对冲）';
  return s.cashCents > 0 ? `付 ${money(s.cashCents)}` : `收 ${money(-s.cashCents)}`;
}

interface TimelineRow extends PartyTimelineEvent {
  key: string;
  seq: number;
  typeLabel: string;
  summary: string;
  sign: string;
  settled: boolean;
  balanceCents: number;
}

const timeline = computed<TimelineRow[]>(() => {
  const base: Array<Omit<TimelineRow, 'balanceCents'>> = [];
  entries.value.forEach((e, i) => {
    base.push({
      key: `e-${e.id}`,
      seq: i,
      date: e.bizDate,
      kind: e.kind,
      amountCents: e.amountCents,
      status: e.status,
      typeLabel: e.status === 'void' ? '作废' : KIND_LABEL[e.kind],
      summary: [e.categoryName || '未分类', e.note].filter(Boolean).join(' · '),
      sign: e.kind === 'income' ? '+' : '−',
      settled: e.settled,
    });
  });
  settlements.value.forEach((s, i) => {
    const seq = entries.value.length + i;
    const summary = `结算单 #${s.id}${s.method ? ` · ${s.method}` : ''}${s.note ? ` · ${s.note}` : ''}`;
    const voided = s.status === 'void';
    const push = (
      key: string,
      kind: 'settle-pay' | 'settle-receive',
      amountCents: number,
      typeLabel: string,
      order: number
    ) => {
      base.push({
        key,
        seq: seq + order,
        date: s.settleDate,
        kind,
        amountCents,
        status: s.status,
        typeLabel,
        summary,
        sign: '',
        settled: s.status === 'active',
      });
    };
    if (s.direction === 'offset') {
      // 互抵单拆成两条事件：逐行余额必须与顶部「未结清」同一套加法（付出 +、收到 −）。
      // 只给净额一行的话，净额为 0 时这一行会被 `checkedCents` 拦下、要么丢事件要么记 0，
      // 两种结果都会让逐行余额与顶部对不上 —— 这正是"两处各算一遍"最容易漂的地方。
      if (s.payCents > 0) {
        push(`s-${s.id}-pay`, 'settle-pay', s.payCents, voided ? '互抵（已撤销）' : '互抵 · 付出部分', 0);
      }
      if (s.receiveCents > 0) {
        push(
          `s-${s.id}-recv`,
          'settle-receive',
          s.receiveCents,
          voided ? '互抵（已撤销）' : '互抵 · 收入部分',
          0.5
        );
      }
      return;
    }
    push(
      `s-${s.id}`,
      s.direction === 'pay' ? 'settle-pay' : 'settle-receive',
      s.amountCents,
      voided ? '结算（已撤销）' : `结算 · ${SETTLE_DIRECTION_LABEL[s.direction]}`,
      0
    );
  });
  // 起点取"合并承接的残额"：这样最后一行 == 顶部「未结清」，用户不用自己加回去
  const points = runningUnsettled(base, ledger.value?.transferCents ?? 0);
  return base
    .map((row, i) => ({ ...row, balanceCents: points[i]?.balanceCents ?? 0 }))
    .sort((a, b) => (a.date === b.date ? b.seq - a.seq : a.date < b.date ? 1 : -1));
});

const canSettleNow = computed(
  () =>
    !!ledger.value &&
    (ledger.value.unsettledPayableCents > 0 || ledger.value.unsettledReceivableCents > 0)
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [rows, es, ss] = await Promise.all([
      api.partyLedger({ partyId: props.partyId, includeArchived: true }),
      api.entries({ partyId: props.partyId, includeVoid: true, limit: 1000 }),
      api.settlements(props.partyId),
    ]);
    ledger.value = rows.find((r) => r.partyId === props.partyId) ?? null;
    entries.value = es;
    settlements.value = ss;
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function onSettled(): Promise<void> {
  settleOpen.value = false;
  await load();
  emit('changed');
}

function askVoid(s: LedgerSettlementRow): void {
  pendingVoid.value = s;
  voidReason.value = '';
  voidError.value = '';
}

async function confirmVoid(): Promise<void> {
  const target = pendingVoid.value;
  if (!target || voidBusy.value) return;
  const why = voidReason.value.trim();
  if (!why) {
    voidError.value = '请填写撤销原因（会记入操作日志）';
    return;
  }
  voidBusy.value = true;
  voidError.value = '';
  try {
    await api.settleVoid(target.id, why);
    pendingVoid.value = null;
    toast(`已撤销结算单 #${target.id}，${target.entryCount} 条恢复未结算`, 'success');
    await load();
    emit('changed');
  } catch (e: unknown) {
    voidError.value = e instanceof Error ? e.message : String(e);
  } finally {
    voidBusy.value = false;
  }
}

function close(): void {
  if (voidBusy.value) return;
  emit('close');
}

onMounted(() => void load());
</script>

<style scoped>
.lg-drawer {
  width: 720px;
}
.lg-head__kind {
  font-size: 12.5px;
  font-weight: 400;
}
.lg-head__spacer {
  flex: 1;
}
.lg-hint {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: var(--wb-text-muted);
}
.lg-nums {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.lg-num {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}
.lg-num__label {
  font-size: 11.5px;
  color: var(--wb-text-muted);
}
.lg-num__value {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.lg-num__value--sm {
  font-size: 12px;
  font-weight: 500;
}
.lg-sec {
  margin-top: 14px;
}
.lg-sec__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
  font-size: 12.5px;
  font-weight: 600;
}
.lg-timeline th,
.lg-timeline td,
.lg-settles th,
.lg-settles td {
  padding: 5px 8px;
  font-size: 12.5px;
  white-space: nowrap;
}
.lg-c-date {
  width: 96px;
}
.lg-c-type {
  width: 108px;
}
.lg-c-summary {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lg-c-state {
  max-width: 200px;
  white-space: normal;
}
.lg-c-ops {
  width: 56px;
}
tr.is-void td {
  color: var(--wb-text-muted);
}
.lg-amt--income {
  color: var(--wb-success);
}
.lg-amt--expense {
  color: var(--wb-danger);
}
</style>
