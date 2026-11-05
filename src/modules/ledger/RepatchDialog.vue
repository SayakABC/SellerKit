<template>
  <!-- 点遮罩不关：这里可能已经填了"撤销结算"的原因，误触关掉等于让用户重来一遍 -->
  <div class="wb-mask">
    <div
      ref="dialogEl"
      class="wb-dialog wb-dialog--lg"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      data-act="repatch-dialog"
    >
      <div class="wb-dialog__head">变更相关人 · 已选 {{ entryIds.length }} 条</div>

      <div class="wb-dialog__body">
        <p v-if="error" class="wb-notice wb-notice--error" data-act="repatch-error">{{ error }}</p>
        <div v-if="loading" class="lg-hint" data-act="repatch-loading">读取选中条目…</div>

        <template v-else-if="preview">
          <div class="lg-sum" data-act="repatch-summary">
            <span>
              合计 <b class="wb-mono">{{ money(preview.unsettledCents + preview.settledCents) }}</b>
              · 未结算 {{ preview.unsettledCount }} 条 / 已结算 {{ preview.settledCount }} 条
            </span>
            <span class="wb-muted">
              涉及 {{ preview.fromParties.length }} 位相关人
            </span>
          </div>

          <p v-if="preview.missingIds.length || preview.voidIds.length" class="wb-notice wb-notice--warn" data-act="repatch-skipped">
            有 {{ preview.missingIds.length }} 条已不存在、{{ preview.voidIds.length }} 条已作废，不会参与本次变更。
          </p>

          <div class="lg-sec">
            <label class="wb-field">
              <span class="wb-field__label">改挂到 <i class="wb-field__req">*</i></span>
              <select v-model.number="toPartyId" class="wb-input" data-act="repatch-target">
                <option :value="0">选择新的相关人…</option>
                <option v-for="p in targets" :key="p.id" :value="p.id">
                  {{ p.name }} · {{ PARTY_KIND_LABEL[p.kind] }}
                </option>
              </select>
              <span class="wb-field__hint">
                只能选未停用、且不是条目当前所属的人（否则等于没改）。
              </span>
            </label>
            <p v-if="!targets.length" class="wb-notice wb-notice--warn">
              一个人都选不了 —— 候选会排掉已停用的人，也排掉这些条目现在所属的人（改给原主等于没改）。
              先关掉这里，点页面右上角的 相关人 按钮新建一位，或把已停用的启用，再回来重新勾选。
            </p>
          </div>

          <div class="lg-sec">
            <span class="wb-field__label">怎么处理已结算的条目</span>
            <div class="lg-modes" role="radiogroup" aria-label="变更路径">
              <button
                v-for="m in MODES"
                :key="m.value"
                class="lg-mode"
                :class="{ 'is-on': mode === m.value, 'is-off': !isAvailable(m.value) }"
                type="button"
                role="radio"
                :aria-checked="mode === m.value"
                :disabled="!isAvailable(m.value)"
                :data-act="`repatch-mode-${m.value}`"
                @click="pickMode(m.value)"
              >
                <span class="lg-mode__head">
                  <b>{{ m.label }}</b>
                  <span v-if="preview.recommended === m.value && isAvailable(m.value)" class="wb-tag is-on">推荐</span>
                  <!-- 这条会把历史结算单作废：不说清张数，用户看不出它跟另两条不是一类操作 -->
                  <span v-if="m.value === 'void-then-move' && isAvailable(m.value)" class="wb-tag is-warn">
                    会作废 {{ preview.settlements.length }} 张结算单
                  </span>
                </span>
                <span class="lg-mode__desc">{{ m.desc }}</span>
                <span v-if="!isAvailable(m.value)" class="lg-mode__off">{{ unavailableReason(m.value) }}</span>
              </button>
            </div>
          </div>

          <div v-if="mode === 'void-then-move'" class="lg-sec" data-act="repatch-settlements">
            <div class="lg-sec__head">
              <span>将作废的结算单</span>
              <span class="wb-muted">{{ preview.settlements.length }} 张 · 合计 {{ money(voidedTotalCents) }}</span>
            </div>
            <div class="wb-table-wrap">
              <table class="wb-table">
                <thead>
                  <tr>
                    <th>结算单</th>
                    <th>相关人</th>
                    <th class="lg-nowrap">日期</th>
                    <th>方向</th>
                    <th class="wb-num">金额</th>
                    <th class="wb-num">条目数</th>
                    <th class="wb-num">本次选中</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="s in preview.settlements" :key="s.id" :data-act="`repatch-settle-${s.id}`">
                    <td class="wb-mono">#{{ s.id }}</td>
                    <td>{{ s.partyName || '—' }}</td>
                    <td class="wb-mono lg-nowrap">{{ s.settleDate }}</td>
                    <td>{{ SETTLE_DIRECTION_LABEL[s.direction] }}</td>
                    <td class="wb-num">{{ money(s.amountCents) }}</td>
                    <td class="wb-num">{{ s.entryCount }}</td>
                    <td class="wb-num">{{ s.selectedCount }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="preview.collateralEntryCount > 0" class="wb-notice wb-notice--warn" data-act="repatch-collateral">
              注意：作废这些结算单会一并把另外 {{ preview.collateralEntryCount }} 条「未选中」的条目恢复为未结算 ——
              它们的余额会重新回到往来台账，需要的话要另出一张新结算单。
            </p>
            <p v-else class="wb-field__hint">这些结算单只结了本次选中的条目，作废不会牵连其他账。</p>
          </div>

          <div class="lg-sec">
            <div class="lg-sec__head">
              <span>原相关人的未结清变化</span>
              <span class="wb-muted">未结清（净额）= 净往来 + 已结算 + 结转</span>
            </div>
            <div class="wb-table-wrap">
              <table class="wb-table" data-act="repatch-impact">
                <thead>
                  <tr>
                    <th>原相关人</th>
                    <th class="wb-num">选中条目</th>
                    <th class="wb-num">当前未结清</th>
                    <th class="wb-num">变更后未结清</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="p in preview.fromParties" :key="p.partyId" :data-act="`repatch-impact-${p.partyId}`">
                    <td>{{ p.partyName || `相关人 #${p.partyId}` }}</td>
                    <td class="wb-num">
                      {{ p.selectedCount }} 条（{{ money(p.selectedCents) }}）
                      <span v-if="p.selectedSettledCount" class="wb-muted">含已结算 {{ p.selectedSettledCount }}</span>
                    </td>
                    <td class="wb-num">{{ money(p.unsettledCents) }}</td>
                    <td class="wb-num lg-strong" :class="{ 'lg-amt--expense': afterCents(p) < 0 }">
                      {{ money(afterCents(p)) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <label class="wb-field">
            <span class="wb-field__label">
              {{ mode === 'void-then-move' ? '撤销结算的原因' : '备注' }}
              <i v-if="mode === 'void-then-move'" class="wb-field__req">*</i>
            </span>
            <textarea
              v-model="reason"
              class="wb-input"
              rows="2"
              data-act="repatch-reason"
              :placeholder="
                mode === 'void-then-move'
                  ? '必填：如「原对接人离职，账转给同事，旧结算单作废重结」'
                  : '选填：如「供应商换人对接」'
              "
            ></textarea>
            <span class="wb-field__hint">
              {{ mode === 'void-then-move' ? '原因会写进每张被作废结算单与操作日志。' : '会写入操作日志。' }}
            </span>
          </label>
        </template>
      </div>

      <div class="wb-dialog__foot">
        <button class="wb-btn" type="button" data-act="repatch-cancel" :disabled="busy" @click="close">取消</button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="repatch-submit"
          :disabled="!canSubmit"
          :title="submitHint"
          @click="submit"
        >
          {{ busy ? '变更中…' : '确认变更' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 批量变更相关人（方案 §6.4 三路）。三条路的判断**全部来自主进程 preview**，这里只负责
// 把「哪条路可用 / 为什么不可用 / 改完之后原人还剩多少」说清楚：
//
//   A `move-all`        仅当所选条目全部未结算；
//   B `move-unsettled`  含已结算时推荐 —— 已结算的留在原人与原结算单（历史零改动）；
//   C `void-then-move`  用户坚持改已结算条目本身时才走，必须填原因；**作废结算单有连带影响**
//                       （同一张单里没选中的条目会一起恢复未结算），必须显式告知。
//
// 结果不给"操作成功"这种无法验证的文案：父组件按返回的 moved/kept/voided 报具体数字。
import { computed, onMounted, ref } from 'vue';
import * as api from './api';
import { useDialogA11y } from './useDialogA11y';
import { PARTY_KIND_LABEL, SETTLE_DIRECTION_LABEL } from './labels';
import { formatCents } from '@/lib/ledger';
import {
  isRepatchModeAvailable,
  preferredRepatchMode,
  repatchModeBlockedReason,
  type RepatchModeChoice,
} from './repatchMode';
import type {
  LedgerPartyRow,
  LedgerRepatchMode,
  LedgerRepatchPartyImpact,
  LedgerRepatchPreview,
  LedgerRepatchResult,
} from '@/types';

const props = defineProps<{
  entryIds: number[];
  parties: LedgerPartyRow[];
}>();

const emit = defineEmits<{ close: []; done: [result: LedgerRepatchResult] }>();

const MODES: Array<{ value: LedgerRepatchMode; label: string; desc: string }> = [
  {
    value: 'move-all',
    label: '直接改挂',
    desc: '把所选条目全部改挂给新人。仅当所选条目都未结算时可用。',
  },
  {
    value: 'move-unsettled',
    label: '只改挂未结算',
    desc: '未结算的改挂给新人，已结算的留在原人与原结算单 —— 历史金额与归属一分不动。',
  },
  {
    value: 'void-then-move',
    label: '撤销结算后改挂',
    desc: '先作废涉及的结算单（必填原因），条目恢复未结算后全部改挂，之后可重新结算。',
  },
];

const preview = ref<LedgerRepatchPreview | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const toPartyId = ref(0);
const mode = ref<RepatchModeChoice>('move-all');
const reason = ref('');
const dialogEl = ref<HTMLElement | null>(null);
useDialogA11y(dialogEl, close);

const fromPartyIds = computed(() => new Set((preview.value?.fromParties ?? []).map((p) => p.partyId)));

const targets = computed(() =>
  props.parties.filter((p) => !p.archived && !fromPartyIds.value.has(p.id))
);

const voidedTotalCents = computed(() =>
  (preview.value?.settlements ?? []).reduce((sum, s) => sum + s.amountCents, 0)
);

function money(cents: number): string {
  return cents < 0 ? `-¥${formatCents(-cents)}` : `¥${formatCents(cents)}`;
}

/** 判据在 `repatchMode.ts`（有单测），组件只负责把它接到界面上 */
function isAvailable(m: LedgerRepatchMode): boolean {
  const p = preview.value;
  if (!p) return false;
  return isRepatchModeAvailable(m, p);
}

function unavailableReason(m: LedgerRepatchMode): string {
  const p = preview.value;
  if (!p) return '';
  return repatchModeBlockedReason(m, p);
}

/** 已结算条目走 C 时，原人剩余未结清按作废结算后的口径；A/B 按"只移未结算" */
function afterCents(p: LedgerRepatchPartyImpact): number {
  return mode.value === 'void-then-move' ? p.afterVoidMoveCents : p.afterMoveCents;
}

function pickMode(m: LedgerRepatchMode): void {
  if (!isAvailable(m)) return;
  mode.value = m;
  error.value = '';
}

function preferredMode(p: LedgerRepatchPreview): RepatchModeChoice {
  return preferredRepatchMode(p);
}

const canSubmit = computed(() => {
  if (loading.value || busy.value || !preview.value) return false;
  if (!toPartyId.value) return false;
  if (!mode.value || !isAvailable(mode.value)) return false;
  if (mode.value === 'void-then-move' && !reason.value.trim()) return false;
  return preview.value.entries.length > 0;
});

const submitHint = computed(() => {
  if (!preview.value) return '读取中…';
  if (!preview.value.entries.length) return '没有可变更的条目';
  if (!toPartyId.value) return '请选择要改挂到的相关人';
  // 全已结算时不预选：明确告诉用户"只能走哪条"，而不是替他选中最危险的那条
  if (!mode.value) return '所选条目全部已结算，只能「撤销结算后改挂」—— 请在上方点选，并填写原因';
  if (!isAvailable(mode.value)) return unavailableReason(mode.value);
  if (mode.value === 'void-then-move' && !reason.value.trim()) return '撤销结算必须填写原因';
  return '执行变更';
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const p = await api.repatchPreview(props.entryIds);
    preview.value = p;
    mode.value = preferredMode(p);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value || !preview.value || !mode.value) return;
  const chosen: LedgerRepatchMode = mode.value;
  busy.value = true;
  error.value = '';
  try {
    // 只提交预览里真实存在且有效的条目：缺失/已作废的 id 会让主进程整批拒绝
    const ids = preview.value.entries.map((e) => e.id);
    const r = await api.repatch({
      entryIds: ids,
      toPartyId: toPartyId.value,
      mode: chosen,
      reason: reason.value.trim() || undefined,
    });
    emit('done', r);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
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
.lg-sec {
  margin-bottom: 12px;
}
.lg-sec__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
  font-size: 12.5px;
  font-weight: 600;
}
.lg-hint {
  padding: 24px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--wb-text-muted);
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
.lg-modes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 6px;
}
@media (max-width: 900px) {
  .lg-modes {
    grid-template-columns: minmax(0, 1fr);
  }
}
.lg-mode {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  color: var(--wb-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.lg-mode:hover {
  border-color: var(--wb-primary);
}
.lg-mode.is-on {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
.lg-mode.is-off {
  cursor: not-allowed;
  opacity: 0.72;
}
.lg-mode.is-off:hover {
  border-color: var(--wb-border);
}
.lg-mode__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.lg-mode__desc {
  font-size: 12px;
  color: var(--wb-text-muted);
  line-height: 1.45;
}
.lg-mode__off {
  font-size: 11.5px;
  color: var(--wb-warning);
  line-height: 1.4;
}
.lg-nowrap {
  white-space: nowrap;
}
.lg-strong {
  font-weight: 600;
}
.lg-amt--expense {
  color: var(--wb-danger);
}
</style>
