<template>
  <div class="wb-mask" @click.self="close">
    <aside class="wb-drawer pue" role="dialog" aria-modal="true" aria-label="拿货单编辑" data-act="pu-editor">
      <div class="wb-dialog__head pue__head">
        <span>拿货单 #{{ order.id }}</span>
        <span class="wb-tag" :class="order.status === 'submitted' ? 'is-on' : 'is-warn'">
          {{ order.status === 'submitted' ? '已提交' : '草稿' }}
        </span>
        <span class="wb-muted">厂家 {{ supplierName || `#${order.supplierId}` }}</span>
        <button class="pue__x" type="button" aria-label="关闭" data-act="pue-close" @click="close">
          ✕
        </button>
      </div>

      <div class="wb-dialog__body pue__body">
        <p v-if="order.status === 'submitted'" class="wb-notice wb-notice--warn" data-act="pue-submitted-note">
          这张单已提交：改动会立即影响对账金额、待拿货缺口与「算钱」里的成本。
        </p>

        <div class="pue__form">
          <label class="wb-field">
            <span class="wb-field__label">拿货日期</span>
            <input v-model="bizDate" class="wb-input wb-input--sm" type="date" data-act="pue-date" />
          </label>
          <!-- 模式**创建时定死**（宿主 `purchase-order-update` 不接受 mode）——
               给一个改不动的下拉框就是"假动作"，所以这里只说明、不提供控件。 -->
          <div class="wb-field">
            <span class="wb-field__label">模式</span>
            <span class="wb-tag">{{ isPackage ? '包价（只记总额）' : '明细（按款色逐行）' }}</span>
            <span class="wb-field__hint">模式在创建时定下、不可更改；要换请新建一张。</span>
          </div>
          <label class="wb-field pue__field--wide">
            <span class="wb-field__label">备注</span>
            <input v-model="note" class="wb-input wb-input--sm" data-act="pue-note" placeholder="选填" />
          </label>
        </div>

        <label v-if="isPackage" class="wb-field pue__pkg">
          <span class="wb-field__label">本次拿货总额（元）</span>
          <input
            v-model="packageYuan"
            class="wb-input"
            type="number"
            min="0"
            step="0.01"
            data-act="pue-package"
          />
          <span class="wb-field__hint">
            包价单只参与厂家对账，不参与待拿货齐货校验与利润计算。
          </span>
        </label>

        <template v-else>
          <div class="pue__bar">
            <span class="wb-muted">
              共 {{ rows.length }} 行 · 单价留空时点「取最近价」按同厂家同款色的历史单价回填
            </span>
            <button type="button" class="wb-btn wb-btn--sm" data-act="pue-add" @click="addRow">
              + 加行
            </button>
          </div>

          <div v-if="rows.length" class="wb-table-wrap">
            <table class="wb-table" data-act="pue-table">
              <thead>
                <tr>
                  <th>款编码</th>
                  <th>款式名</th>
                  <th>款色</th>
                  <th>尺码</th>
                  <th class="wb-num">建议</th>
                  <th class="wb-num">实拿</th>
                  <th class="wb-num">单价(元)</th>
                  <th class="wb-num">金额(元)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rows" :key="r.uid">
                  <td>
                    <input
                      v-model="r.styleCode"
                      class="wb-input wb-input--sm pue__cell"
                      :data-act="`pue-code-${r.uid}`"
                      @change="onCodeChange(r)"
                    />
                  </td>
                  <td>
                    <input v-model="r.styleName" class="wb-input wb-input--sm pue__cell" :data-act="`pue-name-${r.uid}`" />
                  </td>
                  <td>
                    <input
                      v-model="r.color"
                      class="wb-input wb-input--sm pue__cell"
                      :data-act="`pue-color-${r.uid}`"
                      @change="onCodeChange(r)"
                    />
                  </td>
                  <td>
                    <input v-model="r.size" class="wb-input wb-input--sm pue__cell" :data-act="`pue-size-${r.uid}`" />
                  </td>
                  <td class="wb-num wb-muted">{{ r.suggestionQty || '—' }}</td>
                  <td>
                    <input
                      v-model.number="r.qty"
                      class="wb-input wb-input--sm pue__cell wb-num"
                      type="number"
                      min="0"
                      step="1"
                      :data-act="`pue-qty-${r.uid}`"
                    />
                  </td>
                  <td>
                    <input
                      v-model="r.priceText"
                      class="wb-input wb-input--sm pue__cell wb-num"
                      type="number"
                      min="0"
                      step="0.01"
                      :data-act="`pue-price-${r.uid}`"
                    />
                  </td>
                  <td class="wb-num">{{ money(rowAmountCents(r)) }}</td>
                  <td class="pue__ops">
                    <button type="button" class="wb-link" :data-act="`pue-fill-${r.uid}`" @click="fillPrice(r)">
                      取最近价
                    </button>
                    <button
                      type="button"
                      class="wb-link wb-link--danger"
                      :data-act="`pue-delrow-${r.uid}`"
                      @click="removeRow(r.uid)"
                    >
                      删
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="wb-empty" data-act="pue-empty">
            <p class="wb-empty__title">还没有明细行</p>
            <p class="wb-empty__desc">
              点「+ 加行」手工添，或者回「待拿货缺口」勾选要拿的款色一键生成一张。
            </p>
          </div>
        </template>
      </div>

      <div class="wb-dialog__foot pue__foot">
        <span class="pue__total">
          合计 <b data-act="pue-total">¥{{ money(totalCents) }}</b>
        </span>
        <button type="button" class="wb-btn" data-act="pue-cancel" :disabled="saving" @click="close">
          取消
        </button>
        <button
          type="button"
          class="wb-btn wb-btn--primary"
          data-act="pue-save"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
// 拿货单明细编辑（抽屉）。**金额口径只有一处**：明细行金额 = 实拿 × 单价，
// 合计在包价模式下取总额 —— 与主进程 `purchase-db.computeTotal()` 同一公式
// （宿主保存时会按同一公式重算落库，界面这份只是为了实时显示）。
//
// ⚠️ 模式（明细 / 包价）**不可改**：宿主 `purchase-order-update` 不接受 `mode`。
//    给一个改不动的下拉框属于"假动作"（项目明确禁止），所以只说明、不给控件。
import { computed, ref } from 'vue';
import { toast } from '@/core/services/toast';
import type { PurchaseOrder } from '@/types';
import { centsToYuan, money, priceHistory, updateOrder, yuanToCents } from '../purchase';

const props = defineProps<{
  order: PurchaseOrder;
  /** 厂家名（只读展示；厂家归属在创建时锁定） */
  supplierName: string;
}>();

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

interface EditRow {
  /** 行标识：**不能用数组下标** —— 删中间一行时下标会串，输入框的值会串到别的行上 */
  uid: number;
  styleCode: string;
  styleName: string;
  color: string;
  size: string;
  qty: number;
  /** 单价（元）**按用户输入的原文**保留，避免"输入 12.5 → 被改写成 12.50"抢光标 */
  priceText: string;
  suggestionQty: number;
}

let uidSeq = 0;
const nextUid = (): number => ++uidSeq;

const isPackage = computed(() => props.order.mode === 'package');
const bizDate = ref(props.order.bizDate || '');
const note = ref(props.order.note || '');
const packageYuan = ref(centsToYuan(props.order.totalCents).toFixed(2));
const rows = ref<EditRow[]>(
  (props.order.items ?? []).map((it) => ({
    uid: nextUid(),
    styleCode: it.styleCode ?? '',
    styleName: it.styleName ?? '',
    color: it.color ?? '',
    size: it.size ?? '',
    qty: Number(it.qty) || 0,
    priceText: it.priceCents ? String(centsToYuan(it.priceCents)) : '',
    suggestionQty: Number(it.suggestionQty) || 0,
  }))
);
const saving = ref(false);

function rowCents(r: EditRow): number {
  return Math.max(0, Math.round(Number(r.qty) || 0)) * yuanToCents(r.priceText);
}
const rowAmountCents = (r: EditRow): number => rowCents(r);

const totalCents = computed(() =>
  isPackage.value ? yuanToCents(packageYuan.value) : rows.value.reduce((s, r) => s + rowCents(r), 0)
);

function addRow(): void {
  rows.value.push({
    uid: nextUid(),
    styleCode: '',
    styleName: '',
    color: '',
    size: '',
    qty: 0,
    priceText: '',
    suggestionQty: 0,
  });
}

function removeRow(uid: number): void {
  rows.value = rows.value.filter((r) => r.uid !== uid);
}

/**
 * 款色 / 款编码 改完且**单价还是空的**时，自动带出同厂家同款色的最近单价。
 * 只在空价时自动填：已有价格的是用户自己定的，不该被覆盖。
 */
async function onCodeChange(r: EditRow): Promise<void> {
  if (yuanToCents(r.priceText) > 0) return;
  const cents = await priceHistory({
    supplierId: props.order.supplierId,
    styleCode: r.styleCode.trim(),
    color: r.color.trim(),
  }).catch(() => 0);
  if (cents > 0) r.priceText = String(centsToYuan(cents));
}

/** 「取最近价」：**强制**回填（用户主动点的），查不到如实说一句 */
async function fillPrice(r: EditRow): Promise<void> {
  const code = r.styleCode.trim();
  if (!code) return toast('请先填款编码', 'error');
  try {
    const cents = await priceHistory({
      supplierId: props.order.supplierId,
      styleCode: code,
      color: r.color.trim(),
    });
    if (cents <= 0) return toast('没查到该款色的历史单价', 'info');
    r.priceText = String(centsToYuan(cents));
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '查历史价失败', 'error');
  }
}

async function save(): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bizDate.value)) return toast('拿货日期格式不正确', 'error');
  const items = rows.value
    .filter((r) => r.styleCode.trim())
    .map((r) => ({
      styleCode: r.styleCode.trim(),
      styleName: r.styleName,
      color: r.color,
      size: r.size,
      qty: Math.max(0, Math.round(Number(r.qty) || 0)),
      priceCents: yuanToCents(r.priceText),
      suggestionQty: Math.max(0, Math.round(Number(r.suggestionQty) || 0)),
    }));
  if (!isPackage.value && rows.value.length > 0 && items.length === 0) {
    return toast('明细不能全是空行（没填款编码的行不会被保存）', 'error');
  }
  saving.value = true;
  try {
    await updateOrder({
      id: props.order.id,
      bizDate: bizDate.value,
      note: note.value,
      items: isPackage.value ? undefined : items,
      totalCents: isPackage.value ? yuanToCents(packageYuan.value) : undefined,
    });
    emit('saved');
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '保存失败', 'error');
  } finally {
    saving.value = false;
  }
}

function close(): void {
  emit('close');
}
</script>

<style scoped>
.pue__head {
  align-items: center;
}

.pue__x {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 14px;
  cursor: pointer;
}

.pue__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pue__form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 12px;
}

.pue__form .wb-field {
  flex: 0 1 150px;
}

.pue__field--wide {
  flex: 1 1 200px;
}

.pue__pkg {
  max-width: 260px;
}

.pue__bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pue__bar .wb-muted {
  flex: 1;
  min-width: 0;
  font-size: 12px;
}

/* 表格里的输入框要撑满单元格（否则 6 个窄输入框看着像装饰） */
.pue__cell {
  width: 100%;
  min-width: 64px;
}

.pue__ops {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.pue__foot {
  align-items: center;
}

/* 合计推到最左：`.wb-dialog__foot` 是 flex-end，右侧留给两个按钮 */
.pue__total {
  margin-right: auto;
  font-size: 12.5px;
  color: var(--wb-text-muted);
}

.pue__total b {
  font-size: 15px;
  color: var(--wb-text);
  font-variant-numeric: tabular-nums;
}
</style>
