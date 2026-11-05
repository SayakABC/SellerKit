<template>
  <div class="wb-mask" @click.self="onMaskClick">
    <div
      ref="dialogEl"
      class="wb-dialog wb-dialog--md"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      data-act="entry-editor"
    >
      <div class="wb-dialog__head">{{ isEdit ? '编辑这笔账' : '记一笔' }}</div>

      <div class="wb-dialog__body lg-form">
        <div v-if="loading" class="lg-hint">读取中…</div>
        <p v-else-if="loadError" class="wb-notice wb-notice--error" data-act="entry-load-error">
          {{ loadError }}
        </p>

        <template v-else>
          <p v-if="settledLocked" class="wb-notice wb-notice--warn" data-act="entry-locked">
            这条已被结算单 #{{ detail?.settlementId }} 占用：金额、收付方向、相关人、归属与分摊不可改；日期、科目、备注仍可修正。
            <b>记错了人要改挂，用下面的「变更相关人…」</b>（会先撤销这张结算单，原因必填）。
          </p>
          <p v-else-if="existingRevenue" class="wb-notice" data-act="entry-revenue-basis">
            这条按营收占比分摊：参与店铺与基准保持不变；改金额时会按<b>原比例</b>重算，不会因为之后又有新订单而悄悄改动历史分摊。
          </p>

          <div class="lg-row2">
            <label class="wb-field">
              <span class="wb-field__label">金额（元）<i class="wb-field__req">*</i></span>
              <!-- 自动聚焦 + 回车即存：目标"记一笔 15 秒"的第一段就在这里 -->
              <input
                ref="amountInput"
                v-model="amountRaw"
                class="wb-input lg-amount"
                data-act="entry-amount"
                inputmode="decimal"
                placeholder="0.00"
                :disabled="amountLocked"
                @keydown.enter.prevent="save"
              />
              <span v-if="amountError" class="wb-field__hint lg-err">{{ amountError }}</span>
            </label>
            <label class="wb-field">
              <span class="wb-field__label">发生日期</span>
              <input v-model="bizDate" type="date" class="wb-input" data-act="entry-date" />
            </label>
          </div>
          <p v-if="period && month !== ALL_PERIOD && period !== month" class="wb-field__hint" data-act="entry-period-hint">
            这笔属于 {{ period }}（当前在看 {{ month }}），保存后会自动切到 {{ period }}。
          </p>
          <p v-else-if="period && month === ALL_PERIOD" class="wb-field__hint" data-act="entry-period-hint">
            当前在看「全部日期」：新账记在今天（{{ period }}），保存后列表不跳月。
          </p>

          <div class="lg-row2">
            <div class="wb-field">
              <span class="wb-field__label">收 / 支</span>
              <div class="wb-seg" role="tablist" aria-label="收付方向" data-act="entry-kind">
                <button
                  class="wb-seg__item"
                  type="button"
                  role="tab"
                  :class="{ 'is-on': kind === 'income' }"
                  :aria-selected="kind === 'income'"
                  :disabled="kindLocked"
                  data-act="entry-kind-income"
                  @click="setKind('income')"
                >
                  {{ KIND_LABEL.income }}
                </button>
                <button
                  class="wb-seg__item"
                  type="button"
                  role="tab"
                  :class="{ 'is-on': kind === 'expense' }"
                  :aria-selected="kind === 'expense'"
                  :disabled="kindLocked"
                  data-act="entry-kind-expense"
                  @click="setKind('expense')"
                >
                  {{ KIND_LABEL.expense }}
                </button>
              </div>
            </div>
            <label class="wb-field">
              <span class="wb-field__label">科目</span>
              <select v-model.number="categoryId" class="wb-input" data-act="entry-category">
                <option :value="0">未分类</option>
                <option v-for="c in categoryOptions" :key="c.id" :value="c.id">
                  {{ c.name }}{{ c.archived ? '（已停用）' : '' }}
                </option>
              </select>
            </label>
          </div>

          <div class="wb-field">
            <span class="wb-field__label">资金相关人 <i class="wb-field__req">*</i></span>
            <div class="lg-party">
              <select
                v-model.number="partyId"
                class="wb-input lg-party__select"
                data-act="entry-party"
                :disabled="partyLocked"
              >
                <option :value="0">请选择（这笔钱该收谁 / 该付谁）</option>
                <option v-for="p in partyOptions" :key="p.id" :value="p.id">
                  {{ p.name }} · {{ PARTY_KIND_LABEL[p.kind] }}{{ p.archived ? '（已停用）' : '' }}
                </option>
              </select>
              <button
                v-if="!partyLocked"
                class="wb-btn wb-btn--sm"
                type="button"
                data-act="party-new"
                @click="partyFormOpen = !partyFormOpen"
              >
                {{ partyFormOpen ? '收起' : '+ 新建' }}
              </button>
              <!-- 已结算的行：相关人下拉是禁用的，这里必须给一条出路，否则"记错人"只能靠猜 -->
              <button
                v-else
                class="wb-btn wb-btn--sm"
                type="button"
                data-act="entry-repatch"
                title="记错了人：撤销这张结算单后把条目改挂给别的相关人"
                @click="requestRepatch"
              >
                变更相关人…
              </button>
            </div>
            <p v-if="!partyOptions.length" class="wb-field__hint">
              还没有相关人 —— 点「+ 新建」加一个（供应商 / 员工 / 房东 / 平台）。
            </p>
            <div v-if="partyFormOpen" class="lg-party-form">
              <input
                v-model="partyForm.name"
                class="wb-input wb-input--sm"
                data-act="party-new-name"
                placeholder="名称，如：张伟 / 广州某某服装厂"
                @keydown.enter.prevent="createParty"
              />
              <select v-model="partyForm.kind" class="wb-input wb-input--sm" data-act="party-new-kind">
                <option v-for="k in PARTY_KIND_OPTIONS" :key="k.value" :value="k.value">{{ k.label }}</option>
              </select>
              <button
                class="wb-btn wb-btn--sm wb-btn--primary"
                type="button"
                data-act="party-new-save"
                :disabled="partyFormBusy || !partyForm.name.trim()"
                @click="createParty"
              >
                {{ partyFormBusy ? '保存中…' : '保存' }}
              </button>
            </div>
            <p v-if="partyFormError" class="wb-notice wb-notice--error">{{ partyFormError }}</p>
          </div>

          <div class="wb-field">
            <span class="wb-field__label">范围</span>
            <div class="wb-seg" role="tablist" aria-label="条目范围" data-act="entry-scope">
              <button
                class="wb-seg__item"
                type="button"
                role="tab"
                :class="{ 'is-on': scope === 'shop' }"
                :aria-selected="scope === 'shop'"
                :disabled="scopeLocked"
                data-act="entry-scope-shop"
                @click="scope = 'shop'"
              >
                {{ SCOPE_LABEL.shop }}
              </button>
              <button
                class="wb-seg__item"
                type="button"
                role="tab"
                :class="{ 'is-on': scope === 'shared' }"
                :aria-selected="scope === 'shared'"
                :disabled="scopeLocked"
                data-act="entry-scope-shared"
                @click="scope = 'shared'"
              >
                公共（多店分摊）
              </button>
            </div>
          </div>

          <div v-if="scope === 'shop'" class="wb-field">
            <span class="wb-field__label">归属店铺 <i class="wb-field__req">*</i></span>
            <select v-model.number="shopId" class="wb-input" data-act="entry-shop" :disabled="shopLocked">
              <option :value="0">请选择店铺</option>
              <option v-for="s in shops" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
            <p v-if="!shops.length" class="wb-field__hint">
              还没有店铺。
              <button class="wb-link" type="button" data-act="go-shops" @click="goShops">去「基础数据 › 店铺」添加</button>
            </p>
          </div>

          <section v-else class="lg-shared" data-act="entry-shared">
            <div class="lg-shared__head">
              <span class="lg-shared__title">分摊到哪些店</span>
              <span class="wb-muted">{{ participants.length }} 家参与</span>
            </div>

            <div v-if="eligible.length" class="lg-shops">
              <label v-for="s in eligible" :key="s.id" class="lg-shop">
                <input
                  type="checkbox"
                  :checked="participants.includes(s.id)"
                  :disabled="allocLocked"
                  :data-act="`alloc-shop-${s.id}`"
                  @change="toggleShop(s.id)"
                />
                <span>{{ s.name }}</span>
                <span v-if="showRevenueWeights" class="lg-shop__rev">{{ money(revenueWeight(s.id)) }}</span>
              </label>
            </div>
            <p v-else class="wb-field__hint">当前月份没有可参与分摊的店铺（未开业或已停用的店不参与）。</p>

            <!-- 编辑历史条目时，参与店里可能有"现在已停用/当月还没开业"的店：它们不在可选列表里，
                 必须单独列出来，否则用户会以为分摊把某家店丢了。 -->
            <div v-if="extraParticipants.length" class="lg-shops">
              <label v-for="p in extraParticipants" :key="p.id" class="lg-shop is-extra">
                <input
                  type="checkbox"
                  :checked="participants.includes(p.id)"
                  :disabled="allocLocked"
                  @change="toggleShop(p.id)"
                />
                <span>{{ p.name }}（{{ p.reason }}）</span>
                <span v-if="showRevenueWeights" class="lg-shop__rev">{{ money(revenueWeight(p.id)) }}</span>
              </label>
            </div>

            <p v-if="excluded.length" class="wb-field__hint">
              未参与：{{ excluded.map((e) => `${e.name}（${EXCLUDED_REASON_LABEL[e.reason]}）`).join('、') }}
            </p>
            <p v-if="eligibleError" class="wb-notice wb-notice--error">{{ eligibleError }}</p>

            <div class="lg-basis">
              <span class="wb-field__label">分摊基准</span>
              <div class="wb-seg" role="tablist" aria-label="分摊基准" data-act="alloc-basis">
                <button
                  class="wb-seg__item"
                  type="button"
                  role="tab"
                  :class="{ 'is-on': basis === 'equal' }"
                  :aria-selected="basis === 'equal'"
                  :disabled="allocLocked"
                  data-act="alloc-basis-equal"
                  @click="setBasis('equal')"
                >
                  平均分摊
                </button>
                <button
                  class="wb-seg__item"
                  type="button"
                  role="tab"
                  :class="{ 'is-on': basis === 'revenue' }"
                  :aria-selected="basis === 'revenue'"
                  :disabled="allocLocked"
                  data-act="alloc-basis-revenue"
                  @click="setBasis('revenue')"
                >
                  按营收占比
                </button>
                <button
                  class="wb-seg__item"
                  type="button"
                  role="tab"
                  :class="{ 'is-on': basis === 'manual' }"
                  :aria-selected="basis === 'manual'"
                  :disabled="allocLocked"
                  data-act="alloc-basis-manual"
                  @click="setBasis('manual')"
                >
                  手工比例
                </button>
              </div>
              <span class="wb-muted lg-basis__hint">{{ basisHint }}</span>
            </div>

            <!-- 营收占比的取数说明：口径与「统计」页同一份（RK-06），
                 对不上店铺/没写店铺/取数截断都必须**看得见**，不静默按已归属的部分摊钱。 -->
            <div v-if="basis === 'revenue' && !existingRevenue" class="lg-revenue" data-act="alloc-revenue">
              <p v-if="revenueLoading" class="wb-field__hint">正在按 {{ revenuePeriod || period }} 的订单营收计算…</p>
              <p v-else-if="revenueError" class="wb-notice wb-notice--error" data-act="alloc-revenue-error">
                {{ revenueError }}
              </p>
              <template v-else-if="revenue">
                <p v-if="revenue.truncated" class="wb-notice wb-notice--error" data-act="alloc-revenue-truncated">
                  本期订单超过 {{ ORDER_ROW_LIMIT }} 行，只取到前 {{ ORDER_ROW_LIMIT }} 行 —— 按半份数据算占比会把钱摊错。
                  请改用平均或手工比例。
                </p>
                <p v-else class="lg-revenue__sum" data-act="alloc-revenue-sum">
                  本期营收 {{ money(revenue.totalCents) }} · 已归属店铺 {{ money(revenue.assignedTotalCents) }}
                  <span v-if="revenue.excludedClosedRows"> · 已排除关闭单 {{ revenue.excludedClosedRows }} 行</span>
                  <span v-if="revenue.missingRevenueRows"> · 缺金额 {{ revenue.missingRevenueRows }} 行</span>
                </p>
                <p v-if="revenue.unmatched.length" class="wb-notice wb-notice--warn" data-act="alloc-revenue-unmatched">
                  有 {{ money(revenue.unmatchedTotalCents) }} 营收对不上店铺，不参与分摊：{{ unmatchedText }}
                </p>
                <p v-if="revenue.unassignedCents > 0" class="wb-notice wb-notice--warn" data-act="alloc-revenue-unassigned">
                  有 {{ money(revenue.unassignedCents) }} 的订单没写店铺，无法归属，不参与分摊。
                </p>
              </template>
            </div>

            <!-- 分摊方案（周期性固定开销存一次，下次一键套用）。 -->
            <div class="lg-rule">
              <span class="wb-field__label">分摊方案</span>
              <select
                v-model.number="selectedRuleId"
                class="wb-input wb-input--sm lg-rule__select"
                data-act="alloc-rule-select"
                :disabled="allocLocked"
              >
                <option :value="0">不使用方案</option>
                <option v-for="r in rules" :key="r.id" :value="r.id">
                  {{ r.name }} · {{ BASIS_LABEL[r.basis] }}
                </option>
              </select>
              <button
                class="wb-btn wb-btn--sm"
                type="button"
                data-act="alloc-rule-apply"
                :disabled="allocLocked || !selectedRuleId"
                @click="applyRule"
              >
                套用
              </button>
              <button
                class="wb-btn wb-btn--sm"
                type="button"
                data-act="alloc-rule-save-open"
                :disabled="allocLocked || ruleBusy"
                @click="ruleFormOpen = !ruleFormOpen"
              >
                {{ ruleFormOpen ? '收起' : '保存为方案…' }}
              </button>
            </div>
            <p v-if="ruleHint" class="wb-field__hint" data-act="alloc-rule-hint">{{ ruleHint }}</p>
            <div v-if="ruleFormOpen" class="lg-rule-form">
              <input
                v-model="ruleName"
                class="wb-input wb-input--sm"
                data-act="alloc-rule-name"
                placeholder="方案名，如：每月房租 / 公共广告费"
                @keydown.enter.prevent="saveRule"
              />
              <button
                class="wb-btn wb-btn--sm wb-btn--primary"
                type="button"
                data-act="alloc-rule-save"
                :disabled="ruleBusy || !ruleName.trim()"
                @click="saveRule"
              >
                {{ ruleBusy ? '保存中…' : '保存' }}
              </button>
            </div>
            <p v-if="ruleError" class="wb-notice wb-notice--error">{{ ruleError }}</p>

            <div v-if="basis === 'manual'" class="lg-manual">
              <div v-for="p in selectedParticipants" :key="p.id" class="lg-manual__row">
                <span class="lg-manual__name">{{ p.name }}</span>
                <input
                  v-model="manualPct[p.id]"
                  class="wb-input wb-input--sm lg-pct"
                  data-act="alloc-pct"
                  inputmode="decimal"
                  :disabled="allocLocked"
                  @input="markRuleEdited"
                />
                <span class="wb-muted">%</span>
              </div>
              <p class="wb-field__hint" :class="{ 'lg-err': !!manualError }">合计 {{ manualTotalText }}</p>
            </div>

            <div class="lg-preview" data-act="alloc-preview">
              <div class="lg-preview__head">
                <span>保存前预览</span>
                <span v-if="previewRows.length" class="lg-preview__sum" :class="{ 'lg-err': previewGap !== 0 }">
                  合计 {{ money(previewTotal) }} / 条目 {{ money(amountCents ?? 0) }}
                </span>
              </div>
              <p v-if="previewError" class="wb-notice wb-notice--warn" data-act="alloc-error">{{ previewError }}</p>
              <p v-else-if="previewFallback" class="wb-notice wb-notice--warn" data-act="alloc-fallback">
                参与店铺本期都没有营收 —— 已回落为平均分摊（这笔钱仍会按店数摊出去，不会消失）。
              </p>
              <table v-else-if="previewRows.length" class="wb-table lg-preview__table" data-act="alloc-table">
                <thead>
                  <tr>
                    <th>店铺</th>
                    <th v-if="showRevenueWeights" class="wb-num">本期营收</th>
                    <th class="wb-num">摊入</th>
                    <th class="wb-num">占比</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="a in previewRows" :key="a.shopId" :data-alloc-shop="a.shopId">
                    <td>{{ shopName(a.shopId) }}</td>
                    <td v-if="showRevenueWeights" class="wb-num wb-muted" data-act="alloc-revenue-weight">
                      {{ money(revenueWeight(a.shopId)) }}
                    </td>
                    <td class="wb-num" data-act="alloc-amount">{{ money(a.amountCents) }}</td>
                    <td class="wb-num wb-muted">{{ (a.ratioBp / 100).toFixed(2) }}%</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="wb-field__hint">填好金额后，这里会逐店列出摊多少。</p>
            </div>
          </section>

          <label class="wb-field">
            <span class="wb-field__label">备注</span>
            <input
              v-model="note"
              class="wb-input"
              data-act="entry-note"
              placeholder="选填：这笔是什么（如 9 月房租、8 月货款）"
              @keydown.enter.prevent="save"
            />
          </label>

          <p v-if="formError" class="wb-notice wb-notice--error" data-act="entry-form-error">{{ formError }}</p>
        </template>
      </div>

      <div class="wb-dialog__foot">
        <button class="wb-btn" type="button" data-act="entry-cancel" :disabled="busy" @click="close">取消</button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="entry-save"
          :disabled="busy || loading || !!loadError"
          @click="save"
        >
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 「记一笔 / 编辑」弹层（P1）。
//
// 分摊只在 `src/lib/ledger.ts` 算一次：这里调 `computeAllocations` 做**保存前预览**，
// 主进程只做守恒断言、不重算。因此"预览看到的数"与"落库的数"是同一份输出。
//
// 三处刻意锁定（都是为了不产生对不上的账）：
//   · 已结算条目：金额/方向/相关人/归属/分摊不可改（数据库同口径拦截）；
//   · 历史营收占比条目：参与店铺与基准冻结，改金额按**原比例**重算（不重新取营收，
//     否则新订单会让历史分摊悄悄变样）；
//   · 手工比例的合计必须恰好 100%：不做自动补齐（补齐等于替用户猜"少填的那家该摊多少"）。
//
// 营收占比的取数：宿主只回订单行，汇总走 `ledgerRevenue` → `orderCost.computeOrderCosts`，
// 与「统计」页同一份口径（RK-06）。取数截断（>2000 行）时**停用该基准**而不是拿半份数据摊钱。
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import { switchModule } from '@/core/services/shell';
import { localDayKey } from '@/lib/localDay';
import {
  computeAllocations,
  conservationGap,
  defaultBizDate,
  formatCents,
  isValidBizDate,
  parseYuanToCents,
} from '@/lib/ledger';
import type { AllocationRow, LedgerBasis } from '@/lib/ledger';
import { participantRevenueCents, revenueFromOrderRows } from '@/lib/ledgerRevenue';
import type { LedgerRevenue } from '@/lib/ledgerRevenue';
import * as api from './api';
import { ALL_PERIOD } from './useLedger';
import { useDialogA11y } from './useDialogA11y';
import {
  BASIS_LABEL,
  EXCLUDED_REASON_LABEL,
  KIND_LABEL,
  PARTY_KIND_LABEL,
  PARTY_KIND_OPTIONS,
  SCOPE_LABEL,
} from './labels';
import type {
  LedgerCategoryRow,
  LedgerEntryDetail,
  LedgerEntryInput,
  LedgerKind,
  LedgerPartyKind,
  LedgerPartyRow,
  LedgerRuleRow,
  LedgerScope,
  ShopListItem,
} from '@/types';

const props = defineProps<{
  entryId: number | null;
  /** 当前正在看的月份（`YYYY-MM`）—— 决定新条目的默认日期，也用于提示"保存后会切月" */
  month: string;
  defaultKind: LedgerKind;
  categories: LedgerCategoryRow[];
  parties: LedgerPartyRow[];
  shops: ShopListItem[];
  lastParty: { income: number; expense: number };
}>();

const emit = defineEmits<{
  close: [];
  saved: [{ id: number; period: string; created: boolean; kind: LedgerKind; partyId: number }];
  'master-changed': [];
  /** 已结算行改挂：由父层接管（父层持有相关人列表与改挂弹层） */
  repatch: [entryId: number];
}>();

const isEdit = computed(() => props.entryId !== null);

const loading = ref(false);
const loadError = ref('');
const busy = ref(false);
const formError = ref('');

const detail = ref<LedgerEntryDetail | null>(null);

const amountInput = ref<HTMLInputElement | null>(null);
const dialogEl = ref<HTMLElement | null>(null);
useDialogA11y(dialogEl, close);
const amountRaw = ref('');
const bizDate = ref(defaultDate());
const kind = ref<LedgerKind>(props.defaultKind);
const scope = ref<LedgerScope>('shop');
const shopId = ref(0);
const partyId = ref(props.lastParty[props.defaultKind] || 0);
const categoryId = ref(0);
const note = ref('');

const basis = ref<LedgerBasis>('equal');
const participants = ref<number[]>([]);
const manualPct = reactive<Record<number, string>>({});

/** 营收占比的取数状态（按发生月；与「统计」页同一份口径，见 `ledgerRevenue.ts`） */
const ORDER_ROW_LIMIT = 2000;
const revenue = ref<LedgerRevenue | null>(null);
const revenueLoading = ref(false);
const revenueError = ref('');
const revenuePeriod = ref('');
let revenueSeq = 0;

/** 分摊方案（`bk_allocation_rules`）：选中 → 套用；也可把当前配置存成一个方案 */
const rules = ref<LedgerRuleRow[]>([]);
const selectedRuleId = ref(0);
const ruleName = ref('');
const ruleFormOpen = ref(false);
const ruleBusy = ref(false);
const ruleError = ref('');
const ruleHint = ref('');
/** 套用来源（随条目落库，只作留痕；用户改动基准/比例/参与店铺即清掉） */
const ruleId = ref(0);

const eligible = ref<Array<{ id: number; name: string }>>([]);
const excluded = ref<
  Array<{ id: number; name: string; reason: 'not-open-yet' | 'inactive'; status: string }>
>([]);
const eligibleError = ref('');

const localParties = ref<LedgerPartyRow[]>([]);
const partyFormOpen = ref(false);
const partyFormBusy = ref(false);
const partyFormError = ref('');
const partyForm = reactive<{ name: string; kind: LedgerPartyKind }>({ name: '', kind: 'supplier' });

function defaultDate(): string {
  // `props.month` 可能是「全部日期」哨兵；拼 `${month}-01` 会得到 `'all-01'`（见 lib 里的说明）
  return defaultBizDate(props.month, localDayKey());
}

const settledLocked = computed(() => detail.value?.settled === true);
/** 历史条目本来就是按营收占比摊的：参与集合与基准冻结，改金额走**原比例**重算 */
const existingRevenue = computed(() => isEdit.value && detail.value?.basis === 'revenue');
const amountLocked = computed(() => settledLocked.value);
const kindLocked = computed(() => settledLocked.value);
const partyLocked = computed(() => settledLocked.value);
const scopeLocked = computed(() => settledLocked.value || existingRevenue.value);
const shopLocked = computed(() => settledLocked.value || existingRevenue.value);
const allocLocked = computed(() => settledLocked.value || existingRevenue.value);

/** 预览里是否显示"本期营收"一列（历史营收条目显示的是当初的比例，不是现在的营收，故意不显示） */
const showRevenueWeights = computed(
  () =>
    scope.value === 'shared' &&
    basis.value === 'revenue' &&
    !existingRevenue.value &&
    !revenueLoading.value &&
    !revenueError.value &&
    !!revenue.value &&
    !revenue.value.truncated
);

const basisHint = computed(() => {
  if (basis.value === 'equal') return '按参与店数平分，尾差按店铺 id 顺序逐分补齐';
  if (basis.value === 'manual') return '合计必须恰好 100%，不自动补齐';
  return existingRevenue.value
    ? '沿用当初的营收比例（不会因后来新增订单而改动历史分摊）'
    : `按 ${period.value || '本期'} 订单营收占比分摊，与「统计」页同口径`;
});

/** 对不上店铺的营收（未登记 / 同名多店）：逐条标原因，最多列 3 家 */
const unmatchedText = computed(() => {
  const list = revenue.value?.unmatched ?? [];
  const shown = list
    .slice(0, 3)
    .map((u) => `${u.shop} ${money(u.amountCents)}（${u.reason === 'ambiguous' ? '同名多店' : '未登记'}）`)
    .join('、');
  return list.length > 3 ? `${shown} 等 ${list.length} 家` : shown;
});

const amountCents = computed(() => parseYuanToCents(amountRaw.value));
const amountError = computed(() => {
  if (!amountRaw.value.trim()) return '';
  return amountCents.value === null ? '金额要写正数，最多两位小数（如 1280.50）' : '';
});
const period = computed(() => (isValidBizDate(bizDate.value) ? bizDate.value.slice(0, 7) : ''));

const categoryOptions = computed(() =>
  props.categories.filter((c) => c.kind === kind.value && (!c.archived || c.id === categoryId.value))
);

const partyOptions = computed(() => {
  const map = new Map<number, LedgerPartyRow>();
  for (const p of props.parties) if (!p.archived) map.set(p.id, p);
  // 当前已停用的相关人必须仍在选项里：否则打开一条历史条目，下拉显示空白，
  // 一保存就会以为"用户换了人"
  const cur = props.parties.find((p) => p.id === partyId.value);
  if (cur) map.set(cur.id, cur);
  for (const p of localParties.value) map.set(p.id, p);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
});

const selectedParticipants = computed(() =>
  participants.value.map((id) => ({ id, name: shopName(id) }))
);

const extraParticipants = computed<Array<{ id: number; name: string; reason: string }>>(() => {
  const eligibleIds = new Set(eligible.value.map((s) => s.id));
  return participants.value
    .filter((id) => !eligibleIds.has(id))
    .map((id) => {
      const ex = excluded.value.find((e) => e.id === id);
      return {
        id,
        name: shopName(id),
        reason: ex ? EXCLUDED_REASON_LABEL[ex.reason] : '当前月份不可参与',
      };
    });
});

type Preview = { rows: AllocationRow[]; fallback: boolean } | { error: string };

const manualError = computed(() => {
  if (scope.value !== 'shared' || basis.value !== 'manual') return '';
  let total = 0;
  for (const id of participants.value) {
    const bp = pctToBp(manualPct[id]);
    if (bp === null) return '比例要写数字，最多两位小数（0 ~ 100）';
    total += bp;
  }
  if (total !== 10000) {
    const diff = (Math.abs(10000 - total) / 100).toFixed(2);
    return total < 10000
      ? `合计 ${(total / 100).toFixed(2)}%，还差 ${diff} 个百分点`
      : `合计 ${(total / 100).toFixed(2)}%，超出 ${diff} 个百分点`;
  }
  return '';
});

const manualTotalText = computed(() => {
  let total = 0;
  for (const id of participants.value) total += pctToBp(manualPct[id]) ?? 0;
  return `${(total / 100).toFixed(2)}%`;
});

const previewResult = computed<Preview | null>(() => {
  if (scope.value !== 'shared') return null;
  if (!amountCents.value) return null;
  if (!participants.value.length) return { error: '请至少勾选一家参与分摊的店铺' };
  if (basis.value === 'manual' && manualError.value) return { error: manualError.value };
  if (basis.value === 'revenue' && !existingRevenue.value) {
    if (revenueLoading.value) return { error: '正在读取本期营收，请稍候…' };
    if (revenueError.value) return { error: revenueError.value };
    if (!revenue.value) return { error: '本期营收还没读取，无法按营收占比分摊' };
    if (revenue.value.truncated) {
      return {
        error: `本期订单超过 ${ORDER_ROW_LIMIT} 行，只取到部分数据 —— 按半份数据算占比会把钱摊错，请改用平均或手工比例`,
      };
    }
  }
  try {
    const parts =
      basis.value === 'revenue'
        ? existingRevenue.value
          ? storedRevenueParts()
          : revenueParts()
        : participants.value.map((id) => ({
            shopId: id,
            weight: basis.value === 'manual' ? bpOf(id) : 1,
          }));
    const r = computeAllocations(amountCents.value, basis.value, parts);
    return { rows: r.rows, fallback: r.fallback };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

/** 历史营收条目：权重 = 当初各店摊到的金额（Σ = 原金额），改金额时按这组比例缩放 */
function storedRevenueParts(): Array<{ shopId: number; weight: number }> {
  return (detail.value?.allocations ?? []).map((a) => ({ shopId: a.shopId, weight: a.amountCents }));
}

/** 新算的营收权重：参与店铺逐家取本期营收（没有 = 0，交给引擎回落/摊 0） */
function revenueParts(): Array<{ shopId: number; weight: number }> {
  const weights = participantRevenueCents(revenue.value, participants.value);
  return participants.value.map((id, i) => ({ shopId: id, weight: weights[i] ?? 0 }));
}

const previewRows = computed<AllocationRow[]>(() =>
  previewResult.value && 'rows' in previewResult.value ? previewResult.value.rows : []
);
const previewError = computed(() =>
  previewResult.value && 'error' in previewResult.value ? previewResult.value.error : ''
);
const previewFallback = computed(() =>
  previewResult.value && 'rows' in previewResult.value ? previewResult.value.fallback : false
);
const previewTotal = computed(() => previewRows.value.reduce((s, a) => s + a.amountCents, 0));
const previewGap = computed(() =>
  amountCents.value ? conservationGap(amountCents.value, previewRows.value) : 0
);

function money(cents: number): string {
  return `¥${formatCents(cents)}`;
}

/** 预览里这一家店的本期营收（万元以下也照常显示到分；历史营收条目返回当初的摊入金额） */
function revenueWeight(id: number): number {
  if (existingRevenue.value) {
    return detail.value?.allocations.find((a) => a.shopId === id)?.amountCents ?? 0;
  }
  return Number(revenue.value?.byShopId?.[id]) || 0;
}

function shopName(id: number): string {
  const s = props.shops.find((x) => x.id === id);
  if (s) return s.name;
  const e = eligible.value.find((x) => x.id === id) ?? excluded.value.find((x) => x.id === id);
  if (e) return e.name;
  const a = detail.value?.allocations.find((x) => x.shopId === id);
  return a?.shopName || `店铺 #${id}`;
}

/** 百分比文本 → 万分比；空串按 0（保存时由"合计必须 100%"兜住） */
function pctToBp(raw: string | undefined): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const v = Number(s);
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return Math.round(v * 100);
}

function bpOf(id: number): number {
  return pctToBp(manualPct[id]) ?? 0;
}

function seedManualIfEmpty(): void {
  const ids = participants.value;
  if (!ids.length) return;
  if (ids.some((id) => String(manualPct[id] ?? '').trim() !== '')) return;
  const base = Math.floor(10000 / ids.length);
  const left = 10000 - base * ids.length;
  ids.forEach((id, i) => {
    manualPct[id] = ((base + (i < left ? 1 : 0)) / 100).toFixed(2);
  });
}

function setKind(k: LedgerKind): void {
  if (kindLocked.value) return;
  kind.value = k;
}

function setBasis(b: LedgerBasis): void {
  if (allocLocked.value) return;
  if (basis.value !== b) {
    basis.value = b;
    // 用户亲手换了基准 → 这笔账不再"完全来自某个方案"，来源留痕要清掉
    ruleId.value = 0;
    ruleHint.value = '';
  }
}

function toggleShop(id: number): void {
  if (allocLocked.value) return;
  const i = participants.value.indexOf(id);
  if (i >= 0) participants.value.splice(i, 1);
  else participants.value.push(id);
  ruleId.value = 0;
  ruleHint.value = '';
  if (basis.value === 'manual') seedManualIfEmpty();
}

/** 手改比例同理：方案来源不再成立 */
function markRuleEdited(): void {
  ruleId.value = 0;
  ruleHint.value = '';
}

watch(kind, (k) => {
  const cat = props.categories.find((c) => c.id === categoryId.value);
  if (cat && cat.kind !== k) categoryId.value = 0;
  if (!isEdit.value) partyId.value = props.lastParty[k] || 0;
});

/** 从「这家店」切到「公共」时默认全选可参与店铺 —— 不预选的话用户看到的是
 *  「0 家参与 + 请至少勾选一家」，等于每次都要手动把店点一遍。 */
watch(scope, (s) => {
  if (s !== 'shared') return;
  if (!eligible.value.length) {
    void loadEligible();
    return;
  }
  if (!participants.value.length) participants.value = eligible.value.map((x) => x.id);
  if (basis.value === 'manual') seedManualIfEmpty();
});

watch(basis, (b) => {
  if (b === 'manual') seedManualIfEmpty();
  if (b === 'revenue' && !existingRevenue.value) void loadRevenue();
});

watch(period, () => {
  if (scope.value === 'shared') void loadEligible();
  // 营收按**发生月**取：日期一改，占比的依据就换了，必须重取（否则拿上个月的比例摊这个月）
  if (scope.value === 'shared' && basis.value === 'revenue' && !existingRevenue.value) {
    void loadRevenue();
  }
});

async function loadEligible(): Promise<void> {
  // 日期框被清空时按本月取参与店铺，而不是直接 return（return 会让公共区显示"没有可分摊的店铺"）
  const p = period.value || localDayKey().slice(0, 7);
  try {
    const r = await api.eligibleShops(p);
    eligible.value = r.eligible;
    excluded.value = r.excluded;
    eligibleError.value = '';
    if (scope.value === 'shared' && !participants.value.length) {
      participants.value = r.eligible.map((s) => s.id);
    }
  } catch (e: unknown) {
    eligibleError.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * 取本期订单营收（按日期的发生月）。
 *
 * 口径不在这里算：宿主只回订单行（带 `shopKey`），营收汇总与「统计」页共用
 * `orderCost.computeOrderCosts`（RK-06）。`rows.length >= limit` 即视为截断 ——
 * 拿半份数据算占比是最坏的一种"看起来正常"，所以宁可直接停用这个基准。
 */
async function loadRevenue(): Promise<void> {
  const p = period.value;
  if (!p || existingRevenue.value) return;
  const seq = ++revenueSeq;
  revenueLoading.value = true;
  revenueError.value = '';
  revenue.value = null;
  try {
    const rows = await api.monthOrderRows(p, ORDER_ROW_LIMIT);
    if (seq !== revenueSeq) return;
    revenue.value = revenueFromOrderRows({
      orders: rows,
      shops: props.shops.map((s) => ({ id: s.id, name: s.name, nameKey: s.nameKey })),
      limit: ORDER_ROW_LIMIT,
    });
    revenuePeriod.value = p;
  } catch (e: unknown) {
    if (seq === revenueSeq) revenueError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === revenueSeq) revenueLoading.value = false;
  }
}

async function loadRules(): Promise<void> {
  try {
    rules.value = await api.rules();
  } catch (e: unknown) {
    ruleError.value = e instanceof Error ? e.message : String(e);
  }
}

/** 套用方案：只认还存在的店铺；方案里的比例按 shopIds 的顺序对齐 */
function applyRule(): void {
  if (allocLocked.value) return;
  const rule = rules.value.find((r) => r.id === selectedRuleId.value);
  if (!rule) return;
  const alive = new Set(props.shops.map((s) => s.id));
  const kept = rule.shopIds.filter((id) => alive.has(id));
  const dropped = rule.shopIds.length - kept.length;
  if (!kept.length) {
    ruleHint.value = `方案「${rule.name}」里的店铺都已不存在，无法套用`;
    return;
  }
  basis.value = rule.basis;
  participants.value = [...kept];
  if (rule.basis === 'manual') {
    rule.shopIds.forEach((id, i) => {
      manualPct[id] = ((rule.ratios[i] ?? 0) / 100).toFixed(2);
    });
  }
  ruleId.value = rule.id;
  ruleHint.value =
    dropped > 0
      ? `已套用「${rule.name}」；${dropped} 家店已不存在，已跳过`
      : `已套用「${rule.name}」`;
}

async function saveRule(): Promise<void> {
  if (ruleBusy.value) return;
  const name = ruleName.value.trim();
  if (!name) {
    ruleError.value = '请填写方案名';
    return;
  }
  if (!participants.value.length) {
    ruleError.value = '先勾选参与分摊的店铺，再存方案';
    return;
  }
  if (basis.value === 'manual' && manualError.value) {
    ruleError.value = manualError.value;
    return;
  }
  ruleBusy.value = true;
  ruleError.value = '';
  try {
    const r = await api.ruleUpsert({
      name,
      basis: basis.value,
      shopIds: [...participants.value],
      ratios: basis.value === 'manual' ? participants.value.map((id) => bpOf(id)) : [],
    });
    selectedRuleId.value = r.id;
    ruleId.value = r.id;
    ruleName.value = '';
    ruleFormOpen.value = false;
    ruleHint.value = `方案「${name}」已保存，下次记同类开销可直接套用`;
    await loadRules();
    toast('分摊方案已保存', 'success');
  } catch (e: unknown) {
    ruleError.value = e instanceof Error ? e.message : String(e);
  } finally {
    ruleBusy.value = false;
  }
}

async function loadDetail(): Promise<void> {
  if (props.entryId === null) return;
  loading.value = true;
  loadError.value = '';
  try {
    const d = await api.entryDetail(props.entryId);
    if (!d) throw new Error('条目不存在或已被删除');
    detail.value = d;
    amountRaw.value = formatCents(d.amountCents);
    bizDate.value = d.bizDate;
    kind.value = d.kind;
    scope.value = d.scope;
    shopId.value = d.shopId;
    partyId.value = d.partyId;
    categoryId.value = d.categoryId;
    note.value = d.note;
    if (d.scope === 'shared') {
      participants.value = d.allocations.map((a) => a.shopId);
      ruleId.value = d.ruleId || 0;
      selectedRuleId.value = d.ruleId || 0;
      if (d.basis === 'equal' || d.basis === 'revenue' || d.basis === 'manual') {
        basis.value = d.basis;
      }
      if (d.basis === 'manual') {
        for (const a of d.allocations) manualPct[a.shopId] = (a.ratioBp / 100).toFixed(2);
      }
    }
  } catch (e: unknown) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function createParty(): Promise<void> {
  if (partyFormBusy.value) return;
  const name = partyForm.name.trim();
  if (!name) {
    partyFormError.value = '请填写相关人名称';
    return;
  }
  partyFormBusy.value = true;
  partyFormError.value = '';
  try {
    const r = await api.partyUpsert({ name, kind: partyForm.kind });
    localParties.value.push({
      id: r.id,
      name,
      kind: partyForm.kind,
      phone: '',
      note: '',
      archived: false,
      // 刚新建的人不可能是合并来的（合并只发生在已有记录上）
      mergedTo: 0,
      createdAt: '',
      updatedAt: '',
      entryCount: 0,
    });
    partyId.value = r.id;
    partyForm.name = '';
    partyFormOpen.value = false;
    emit('master-changed');
    toast('相关人已创建', 'success');
  } catch (e: unknown) {
    partyFormError.value = e instanceof Error ? e.message : String(e);
  } finally {
    partyFormBusy.value = false;
  }
}

function goShops(): void {
  // 「新增店铺」按钮在「店铺」页签（`accounts`）里；`registry` 是店名归一，跳那儿等于把人送错页。
  switchModule('shop-accounts', 'accounts');
}

function close(): void {
  if (busy.value) return;
  emit('close');
}

/** 已结算行改挂：交给父层打开改挂弹层（本层是表单，不自己再弹一层） */
function requestRepatch(): void {
  if (!props.entryId) return;
  emit('repatch', props.entryId);
}

/** 表单里已经填了东西就别让点遮罩一键清空（用户不是想丢弃，多半是手滑） */
function onMaskClick(): void {  if (busy.value) return;
  const dirty = amountRaw.value.trim() !== '' || partyId.value > 0 || note.value.trim() !== '';
  if (dirty && !isEdit.value) {
    toast('已填写内容，未关闭。要放弃请点「取消」', 'info');
    return;
  }
  close();
}

async function save(): Promise<void> {
  if (busy.value) return;
  formError.value = '';

  if (!isValidBizDate(bizDate.value)) {
    formError.value = '发生日期不合法';
    return;
  }
  if (!amountCents.value) {
    formError.value = amountRaw.value.trim()
      ? '金额要写正数，最多两位小数（如 1280.50）'
      : '请填写金额';
    amountInput.value?.focus();
    return;
  }
  if (!partyId.value) {
    formError.value = '请选择资金相关人（这笔钱该收谁 / 该付谁）';
    return;
  }
  if (scope.value === 'shop' && !shopId.value) {
    formError.value = '请选择归属店铺';
    return;
  }
  let allocRows: AllocationRow[] | null = null;
  let appliedBasis: LedgerBasis = basis.value;
  if (scope.value === 'shared') {
    if (!participants.value.length) {
      formError.value = '公共开支至少要选一家参与分摊的店铺';
      return;
    }
    if (basis.value === 'revenue' && !existingRevenue.value) {
      if (revenueLoading.value) {
        formError.value = '正在读取本期营收，请稍候…';
        return;
      }
      if (revenueError.value) {
        formError.value = revenueError.value;
        return;
      }
      if (!revenue.value) {
        formError.value = '本期营收还没读取，无法按营收占比分摊';
        return;
      }
      if (revenue.value.truncated) {
        formError.value = `本期订单超过 ${ORDER_ROW_LIMIT} 行，只取到部分数据 —— 请改用平均或手工比例`;
        return;
      }
    }
    // 历史营收条目：金额没变就不重传分摊（库里那几行照旧，updated_at 不虚动）；
    // 金额改了才按**原比例**重算 —— 不重新取营收，免得"新订单进来"改动历史分摊。
    const amountChanged = !detail.value || detail.value.amountCents !== amountCents.value;
    const needsAlloc = !existingRevenue.value || amountChanged;
    if (needsAlloc) {
      if (previewError.value) {
        formError.value = previewError.value;
        return;
      }
      if (!previewRows.value.length) {
        formError.value = '分摊预览未生成，请检查参与店铺与金额';
        return;
      }
      // 守恒是落库前的硬门槛（主进程也会再断言一次，这里只是让提示更早出现）
      if (previewGap.value !== 0) {
        formError.value = `分摊合计与金额相差 ${formatCents(Math.abs(previewGap.value))} 元，已阻止保存`;
        return;
      }
      allocRows = previewRows.value;
      // 回落平均时如实记成 `equal`（存的是**实际生效**的基准，不是用户点过哪个按钮）
      if (basis.value === 'revenue' && previewFallback.value) appliedBasis = 'equal';
    }
  }

  const payload: LedgerEntryInput = {
    id: props.entryId ?? undefined,
    bizDate: bizDate.value,
    kind: kind.value,
    scope: scope.value,
    partyId: partyId.value,
    categoryId: categoryId.value,
    amountCents: amountCents.value,
    note: note.value.trim(),
  };
  if (scope.value === 'shop') {
    payload.shopId = shopId.value;
  } else {
    payload.basis = appliedBasis;
    // 总是显式带上来源 id（0 = 未套用）：漏传时主进程会沿用库里旧值，
    // 用户换掉基准/比例后旧方案的 id 就会永远挂在这笔账上。
    payload.ruleId = ruleId.value;
    if (allocRows) {
      payload.allocations = allocRows.map((r) => ({
        shopId: r.shopId,
        amountCents: r.amountCents,
        ratioBp: r.ratioBp,
      }));
    }
  }

  busy.value = true;
  try {
    const r = await api.entryUpsert(payload);
    emit('saved', {
      id: r.id,
      period: period.value,
      created: r.created,
      kind: kind.value,
      partyId: partyId.value,
    });
  } catch (e: unknown) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  if (isEdit.value) await loadDetail();
  await loadEligible();
  void loadRules();
  if (scope.value === 'shared' && !participants.value.length) {
    participants.value = eligible.value.map((s) => s.id);
  }
  if (basis.value === 'manual') seedManualIfEmpty();
  if (basis.value === 'revenue' && !existingRevenue.value) void loadRevenue();
  await nextTick();
  amountInput.value?.focus();
  amountInput.value?.select();
});
</script>

<style scoped>
.lg-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.lg-hint {
  padding: 24px 0;
  text-align: center;
  color: var(--wb-text-muted);
  font-size: 13px;
}
.lg-row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.lg-amount {
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.lg-err {
  color: var(--wb-danger);
}

.lg-party {
  display: flex;
  align-items: center;
  gap: 8px;
}
.lg-party__select {
  flex: 1;
}
.lg-party-form {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.lg-shared {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}
.lg-shared__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.lg-shared__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
}
.lg-shops {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}
.lg-shop {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  cursor: pointer;
}
.lg-shop input {
  accent-color: var(--wb-primary);
}
.lg-shop.is-extra {
  color: var(--wb-warning);
}

.lg-basis {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.lg-basis__hint {
  font-size: 12px;
}

.lg-manual {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lg-manual__row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.lg-manual__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.lg-pct {
  width: 84px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.lg-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  border: 1px solid var(--wb-border);
}
.lg-preview__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--wb-text-muted);
}
.lg-preview__sum {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--wb-text);
}
.lg-preview__table {
  font-size: 12.5px;
}

.lg-shop__rev {
  font-size: 12px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}

.lg-revenue {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lg-revenue__sum {
  font-size: 12.5px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}

.lg-rule {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.lg-rule__select {
  flex: 1;
  min-width: 160px;
}
.lg-rule-form {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
