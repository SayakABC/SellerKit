<template>
  <div class="wb-mask" @click.self="close">
    <div
      ref="dialogEl"
      class="wb-dialog wb-dialog--lg"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      data-act="settle-dialog"
    >
      <div class="wb-dialog__head">
        结算 · {{ partyName }}
      </div>

      <div class="wb-dialog__body">
        <div class="lg-sec">
          <span class="wb-field__label">方向</span>
          <div class="wb-seg" role="radiogroup" aria-label="结算方向">
            <button
              v-for="d in DIRECTIONS"
              :key="d.value"
              class="wb-seg__item"
              type="button"
              role="radio"
              :aria-checked="direction === d.value"
              :class="{ 'is-on': direction === d.value }"
              :data-act="`settle-direction-${d.value}`"
              @click="setDirection(d.value)"
            >
              {{ d.label }}<template v-if="d.value !== 'offset'">（{{ money(availableOf(d.value)) }}）</template>
            </button>
          </div>
          <p class="wb-field__hint" data-act="settle-hint">
            <template v-if="direction === 'offset'">
              互抵结清：同时勾选收入与支出条目，两边一起核销，只发生差额资金流（可以是 0）。
              单据仍按毛额记账，逐笔可追溯。
            </template>
            <template v-else>
              方向必须与条目一致：结算不会新增收支，只把已发生的账标记为已结清。金额 = 勾选条目之和。
            </template>
          </p>
          <p
            v-if="hasBothSides && direction !== 'offset'"
            class="wb-field__hint"
            data-act="settle-offset-tip"
          >
            这个人两个方向都有未结条目（可收 {{ money(balance.unsettledReceivableCents) }}、可付
            {{ money(balance.unsettledPayableCents) }}）。如果本来就打算互相抵掉，选「互抵结清」可以一次结清，
            只走差额（差额为 0 就不用走钱）。
          </p>
        </div>

        <div class="lg-sec">
          <div class="lg-sec__head">
            <span>
              {{
                direction === 'offset'
                  ? '未结算条目（收/支都可勾）'
                  : `未结算${direction === 'pay' ? '支出' : '收入'}条目`
              }}
            </span>
            <span class="wb-muted">{{ candidates.length }} 条</span>
            <span class="lg-sec__spacer"></span>
            <button
              v-if="candidates.length"
              class="wb-link"
              type="button"
              data-act="settle-select-all"
              @click="toggleAll"
            >
              {{ allSelected ? '全不选' : '全选' }}
            </button>
          </div>

          <div v-if="loading" class="lg-hint">读取中…</div>
          <div v-else-if="!candidates.length" class="lg-hint" data-act="settle-empty">
            {{
              direction === 'offset'
                ? '没有未结算条目；先记账，或换一个方向。'
                : `${direction === 'pay' ? '支出' : '收入'}方向没有未结算条目；换一个方向，或先记账。`
            }}
          </div>
          <div v-else class="wb-table-wrap lg-list">
            <table class="wb-table" data-act="settle-entries">
              <thead>
                <tr>
                  <th class="lg-c-check"></th>
                  <th class="lg-c-date">日期</th>
                  <th v-if="direction === 'offset'" class="lg-c-kind">收/支</th>
                  <th>科目</th>
                  <th>备注</th>
                  <th class="wb-num lg-c-amt">金额</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="e in candidates" :key="e.id" :data-settle-entry="e.id">
                  <td class="lg-c-check">
                    <input
                      type="checkbox"
                      :checked="selected.has(e.id)"
                      :data-act="`settle-entry-${e.id}`"
                      @change="toggle(e.id)"
                    />
                  </td>
                  <td class="wb-mono lg-nowrap">{{ e.bizDate }}</td>
                  <td v-if="direction === 'offset'" class="lg-c-kind">
                    <span class="wb-tag" :class="{ 'is-on': e.kind === 'income' }">{{ KIND_LABEL[e.kind] }}</span>
                  </td>
                  <td>{{ e.categoryName || '未分类' }}</td>
                  <td class="lg-c-note" :class="{ 'wb-muted': !e.note }">
                    <span class="lg-note" :title="e.note">{{ e.note || '—' }}</span>
                  </td>
                  <td class="wb-num">{{ money(e.amountCents) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="lg-sum">
          <span v-if="direction === 'offset'">
            已选 <b>{{ selected.size }}</b> 条：支出
            <b class="wb-mono">{{ money(payCents) }}</b> · 收入
            <b class="wb-mono">{{ money(receiveCents) }}</b>
          </span>
          <span v-else>
            已选 <b>{{ selected.size }}</b> 条，合计
            <b class="wb-mono" data-act="settle-total">{{ money(totalCents) }}</b>
          </span>
          <span v-if="direction === 'offset'" class="wb-muted" data-act="settle-cash">
            资金流 <b class="wb-mono">{{ cashLabel }}</b>
          </span>
          <span v-else class="wb-muted" data-act="settle-limit">
            {{ direction === 'pay' ? '应付' : '应收' }}方向可结 {{ money(available) }}
          </span>
        </div>
        <p v-if="check && !check.ok && totalCents > 0" class="wb-notice wb-notice--error">
          {{ check.message }}
        </p>

        <div class="lg-form">
          <label class="wb-field">
            <span class="wb-field__label">结算日期 <i class="wb-field__req">*</i></span>
            <input v-model="settleDate" class="wb-input" type="date" data-act="settle-date" />
          </label>
          <label class="wb-field">
            <span class="wb-field__label">结算方式</span>
            <select v-model="method" class="wb-input" data-act="settle-method">
              <option v-for="m in METHODS" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>
          <label class="wb-field">
            <span class="wb-field__label">备注</span>
            <input v-model="note" class="wb-input" data-act="settle-note" placeholder="选填：如转账号 / 现金经手人" />
          </label>
        </div>
      </div>

      <!-- 错误必须紧贴按钮：写在 body 顶部时，中间隔着最大 240px 的可滚动列表，
           表现就是"点了没反应"（审查 P1-9） -->
      <p v-if="error" ref="errorEl" class="wb-notice wb-notice--error lg-foot-error" data-act="settle-error">
        {{ error }}
      </p>
      <div class="wb-dialog__foot">
        <button class="wb-btn" type="button" data-act="settle-cancel" :disabled="busy" @click="close">
          取消
        </button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="settle-submit"
          :disabled="busy || !canSubmit"
          :title="canSubmit ? '生成结算单' : submitHint"
          @click="submit"
        >
          {{ busy ? '结算中…' : '确认结算' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 「结算」弹层（P3）。四条硬约束都落在这里：
//   ① **金额不可手填** —— 只显示勾选条目之和（`settlementAmountOf`），提交也不传金额，
//      主进程按条目 id 再求一次和（方案 §6.3）；
//   ② **方向与条目类型绑定** —— 我付出只能勾支出、对方付我只能勾收入；切方向即清空勾选，
//      避免"勾着支出却按收款提交"这种看起来有值、实际会两边同时算错的组合；
//   ③ **上限是按方向的余额**，不是净额（`canSettle` 的注释讲了为什么）；
//   ④ **互抵例外**（2026-10-27）：互抵单两边都勾、两侧各减各的余额，只走差额资金流。
//      它不是"按净额结算" —— 毛额仍然完整落到结算行上，单据金额与行和恒等（对账断言不破）。
import { computed, nextTick, onMounted, ref } from 'vue';
import * as api from './api';
import { useDialogA11y } from './useDialogA11y';
import { KIND_LABEL, SETTLE_DIRECTION_LABEL } from './labels';
import { formatCents } from '@/lib/ledger';
import { canOffsetSettle, canSettle, settlementAmountOf, type PartyBalance } from '@/lib/partyLedger';
import { localDayKey } from '@/lib/localDay';
import { toast } from '@/core/services/toast';
import type { LedgerEntryRow, LedgerPartyLedgerRow } from '@/types';

type Direction = 'pay' | 'receive' | 'offset';

const props = defineProps<{
  partyId: number;
  partyName: string;
  balance: Pick<LedgerPartyLedgerRow, keyof PartyBalance>;
  /** 从明细页批量勾选进来时预勾这些条目（仍可增删；只认有效且同方向的） */
  initialEntryIds?: number[];
  /** 批量入口已知方向（按勾选条目的收/支），避免默认方向与勾选不一致 */
  initialDirection?: Direction;
}>();

const emit = defineEmits<{ close: []; done: [] }>();

const DIRECTIONS: Array<{ value: Direction; label: string }> = [
  { value: 'pay', label: SETTLE_DIRECTION_LABEL.pay },
  { value: 'receive', label: SETTLE_DIRECTION_LABEL.receive },
  { value: 'offset', label: SETTLE_DIRECTION_LABEL.offset },
];

const METHODS = ['银行转账', '微信', '支付宝', '现金', '其他'];

const direction = ref<Direction>(
  props.initialDirection ?? (props.balance.unsettledPayableCents > 0 ? 'pay' : 'receive')
);
const entries = ref<LedgerEntryRow[]>([]);
const selected = ref(new Set<number>());
const settleDate = ref(localDayKey());
const method = ref(METHODS[0]);
const note = ref('');
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const errorEl = ref<HTMLElement | null>(null);
const dialogEl = ref<HTMLElement | null>(null);
useDialogA11y(dialogEl, close);

function money(cents: number): string {
  return cents < 0 ? `-¥${formatCents(-cents)}` : `¥${formatCents(cents)}`;
}

/**
 * 方向 → 条目类型：付出结支出，收到结收入（与主进程 createSettlement 的 wantKind 同一口径）。
 * 互抵单没有单一方向，返回 null 表示"两类都要"。
 */
const wantKind = computed<'expense' | 'income' | null>(() =>
  direction.value === 'pay' ? 'expense' : direction.value === 'receive' ? 'income' : null
);

const candidates = computed(() =>
  entries.value.filter((e) => !e.settled && (wantKind.value === null || e.kind === wantKind.value))
);

const selectedEntries = computed(() => candidates.value.filter((e) => selected.value.has(e.id)));

const selectedAmounts = computed(() => selectedEntries.value.map((e) => e.amountCents));

/** 毛额 = 勾选条目之和（互抵单也是毛额，单据金额与结算行之和恒等） */
const totalCents = computed(() => settlementAmountOf(selectedAmounts.value));

const payCents = computed(() =>
  selectedEntries.value.filter((e) => e.kind === 'expense').reduce((s, e) => s + e.amountCents, 0)
);
const receiveCents = computed(() =>
  selectedEntries.value.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amountCents, 0)
);
/** 实际资金流：正 = 我净付出，负 = 我净收到，0 = 完全对冲 */
const cashCents = computed(() => payCents.value - receiveCents.value);

function availableOf(d: Direction): number {
  if (d === 'offset') return 0; // 互抵没有单一方向的额度，两个方向各自校验
  return d === 'pay' ? props.balance.unsettledPayableCents : props.balance.unsettledReceivableCents;
}

const available = computed(() => availableOf(direction.value));

/** 两边都有未结余额 → 提示可以直接互抵（这正是"收支相同却还要付钱"那个困惑的出口） */
const hasBothSides = computed(
  () => props.balance.unsettledPayableCents > 0 && props.balance.unsettledReceivableCents > 0
);

const check = computed(() => {
  if (direction.value === 'offset') {
    // 空勾选不报错（用户还没开始选），一旦有勾选就按两侧余额校验
    if (!selectedEntries.value.length) return null;
    return canOffsetSettle(props.balance, payCents.value, receiveCents.value);
  }
  return totalCents.value > 0 ? canSettle(props.balance, direction.value, totalCents.value) : null;
});

const allSelected = computed(
  () => candidates.value.length > 0 && candidates.value.every((e) => selected.value.has(e.id))
);

const canSubmit = computed(
  () =>
    selected.value.size > 0 &&
    !!settleDate.value &&
    totalCents.value > 0 &&
    (!check.value || check.value.ok)
);

/** 互抵单的实付文案（毛额看不出到底要不要给钱，必须单独写清楚） */
const cashLabel = computed(() => {
  const v = cashCents.value;
  if (v === 0) return '¥0（不用走钱）';
  return v > 0 ? `付 ${money(v)}` : `收 ${money(-v)}`;
});

const submitHint = computed(() => {
  if (!selected.value.size) return '请先勾选要结算的条目';
  if (!settleDate.value) return '请填写结算日期';
  if (check.value && !check.value.ok) return check.value.message;
  return '';
});

function setDirection(d: Direction): void {
  if (direction.value === d) return;
  direction.value = d;
  selected.value = new Set();
  error.value = '';
}

/** 提交成功后的回执文案：互抵单只说"合计"会让用户以为付了毛额那么多钱 */
function settledSummary(r: { amountCents: number; cashCents: number }): string {
  if (direction.value !== 'offset') return `合计 ${money(r.amountCents)}`;
  const cash =
    r.cashCents === 0
      ? '无需走钱'
      : r.cashCents > 0
        ? `实付 ${money(r.cashCents)}`
        : `实收 ${money(-r.cashCents)}`;
  return `毛额 ${money(r.amountCents)}、${cash}`;
}

function toggle(id: number): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(candidates.value.map((e) => e.id));
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    // 只取未结算条目（主进程按 settlement_lines.active 判定），已结算的不会再出现在这里
    entries.value = await api.entries({ partyId: props.partyId, settleStatus: 'unsettled', limit: 1000 });
    // 批量入口带进来的勾选：只保留当前方向下的未结算条目（换了方向就清空，与手动切换一致）
    const preset = new Set(props.initialEntryIds ?? []);
    if (preset.size) {
      selected.value = new Set(
        entries.value
          .filter(
            (e) =>
              preset.has(e.id) && !e.settled && (wantKind.value === null || e.kind === wantKind.value)
          )
          .map((e) => e.id)
      );
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const ids = candidates.value.filter((e) => selected.value.has(e.id)).map((e) => e.id);
    // 刻意不传金额：主进程按勾选条目求和，服务端是唯一算法
    const r = await api.settleCreate({
      partyId: props.partyId,
      settleDate: settleDate.value,
      direction: direction.value,
      entryIds: ids,
      method: method.value,
      note: note.value.trim() || undefined,
    });
    toast(`已生成结算单 #${r.id}：${r.entryCount} 条，${settledSummary(r)}`, 'success');
    emit('done');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = msg;
    // 超额 / 条目被别的结算单占用 / 余额刚被改动 —— 这些正是必须看见原因的场景。
    // 同模块其它失败路径都走 toast，唯独这里不弹，表现就是"按钮点了没反应"（审查 P1-9）
    toast(`结算失败：${msg}`, 'error');
    void nextTick(() => errorEl.value?.scrollIntoView({ block: 'nearest' }));
  } finally {
    busy.value = false;
  }
}

function close(): void {
  if (busy.value) return;
  emit('close');
}

onMounted(() => void load());
</script>

<style scoped>
/* 弹层级的错误块：在页脚正上方，紧贴按钮 */
.lg-foot-error {
  margin: 0 16px 8px;
}
.lg-sec {
  margin-bottom: 12px;
}
.lg-sec__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12.5px;
  font-weight: 600;
}
.lg-sec__spacer {
  flex: 1;
}
.lg-list {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
}
.lg-c-check {
  width: 34px;
}
.lg-c-check input {
  accent-color: var(--wb-primary);
}
.lg-c-date {
  width: 100px;
}
.lg-c-kind {
  width: 64px;
}
.lg-c-amt {
  width: 110px;
}
.lg-c-note {
  max-width: 240px;
}
.lg-note {
  display: inline-block;
  max-width: 230px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}
.lg-sum {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  margin-bottom: 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
  font-size: 12.5px;
}
.lg-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.lg-hint {
  padding: 18px 12px;
  text-align: center;
  font-size: 12.5px;
  color: var(--wb-text-muted);
  border: 1px dashed var(--wb-border);
  border-radius: var(--wb-radius-md);
}
</style>
