<template>
  <div class="wb-mask" @click.self="close">
    <aside class="wb-drawer pue" role="dialog" aria-modal="true" aria-label="拿货单编辑" data-act="pu-editor">
      <div class="wb-dialog__head pue__head">
        <span>拿货单 #{{ order.id }}</span>
        <span class="wb-tag" :class="order.status === 'submitted' ? 'is-on' : 'is-warn'">
          {{ order.status === 'submitted' ? '已提交' : '草稿' }}
        </span>
        <!-- 模式**创建时定死**（宿主 `purchase-order-update` 不接受 mode）——
             给一个改不动的下拉框就是"假动作"，所以页头只给只读标签；措辞与拿货单列表逐字一致。 -->
        <span
          class="wb-tag"
          data-act="pue-mode-tag"
          :title="isPackage ? '包价：只记总额' : '明细：按款色逐行记数量与单价'"
        >
          {{ isPackage ? '包价' : '明细' }}
        </span>
        <span class="wb-muted">厂家 {{ supplierName || `#${order.supplierId}` }}</span>
        <button class="pue__x" type="button" aria-label="关闭" data-act="pue-close" @click="close">
          ✕
        </button>
      </div>

      <div class="wb-dialog__body pue__body">
        <p v-if="order.status === 'submitted'" class="wb-notice wb-notice--warn" data-act="pue-submitted-note">
          {{ submittedNotice }}
        </p>

        <!-- 一行工具条：日期 + 提示 + 加行。原来日期（label 两行）与提示句各占一整行，
             两行都在挤正文区的纵向空间，且把操作拆到了上下两处（2026-10-10 重设计）。 -->
        <div class="pue__bar">
          <label class="pue__date">
            <span class="wb-muted">拿货日期</span>
            <input v-model="bizDate" class="wb-input wb-input--sm" type="date" data-act="pue-date" />
          </label>
          <template v-if="!isPackage">
            <span class="pue__hint wb-muted">单价可留空，点「取最近价」按同厂家同款色回填</span>
            <button type="button" class="wb-btn wb-btn--sm" data-act="pue-add" @click="addRow">
              + 加行
            </button>
          </template>
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
          <span class="wb-field__hint">包价单只记总额：参与厂家对账，不扣拿货缺口、不进成本。</span>
        </label>

        <template v-else>
          <!-- 表列宽由 colgroup 固定（`table-layout: fixed`），款色列吃掉剩余宽度。
               2026-10-10 前表格固有宽度 658px > 抽屉内容区宽度 ⇒ 金额列被裁半边、
               行尾操作列落在视窗外（静默不可达）；现在 8 列恰好等于内容宽度，不再横溢出。 -->
          <div v-if="rows.length" class="wb-table-wrap">
            <table class="wb-table pue__table" data-act="pue-table">
              <colgroup>
                <col class="pue__c-img" />
                <col />
                <col class="pue__c-size" />
                <col class="pue__c-sug" />
                <col class="pue__c-qty" />
                <col class="pue__c-price" />
                <col class="pue__c-amt" />
                <col class="pue__c-ops" />
              </colgroup>
              <thead>
                <tr>
                  <th class="pue__imgcell">图片</th>
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
                  <td class="pue__imgcell">
                    <img
                      v-if="thumbOf(r)"
                      class="pue__thumb"
                      :src="thumbOf(r)"
                      alt=""
                      :data-act="`pue-img-${r.uid}`"
                    />
                    <span
                      v-else-if="resolvedNoImage(r)"
                      class="pue__noimg"
                      :data-act="`pue-noimg-${r.uid}`"
                      >缺图</span
                    >
                  </td>
                  <td>
                    <!-- 款色 = 款编码 + 颜色（都还能改，改完重查单价与行图）。
                         `pue__ghost`：身份数据默认长得像文字（无边框无底色），点进去才变输入框
                         —— 方框会读成"这里要我填什么"（2026-10-10 用户反馈）。
                         款名只作行内提示 —— 权威在产品库（ADR-002 D1），不在这里编辑 -->
                    <div class="pue__style">
                      <input
                        v-model="r.styleCode"
                        class="wb-input wb-input--sm pue__ghost pue__code"
                        placeholder="款编码"
                        :data-act="`pue-code-${r.uid}`"
                        @change="onCodeChange(r)"
                      />
                      <input
                        v-model="r.color"
                        class="wb-input wb-input--sm pue__ghost pue__color"
                        placeholder="颜色"
                        :data-act="`pue-color-${r.uid}`"
                        @change="onCodeChange(r)"
                      />
                    </div>
                    <div
                      v-if="r.styleName"
                      class="pue__name"
                      :title="r.styleName"
                      :data-act="`pue-name-${r.uid}`"
                    >
                      {{ r.styleName }}
                    </div>
                  </td>
                  <td>
                    <input
                      v-model="r.size"
                      class="wb-input wb-input--sm pue__ghost pue__cell"
                      placeholder="尺码"
                      :data-act="`pue-size-${r.uid}`"
                      @change="onSizeChange(r)"
                    />
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
                    <!-- 文字按钮，不是图标：↻ / ✕ 说不出含义（2026-10-10 用户反馈"完全不知道
                         是什么意思"）。与「拿了什么」列表的行尾动作同一套（.wb-link），窄列里竖排两行。 -->
                    <button
                      type="button"
                      class="wb-link pue__oplink"
                      title="按同厂家同款色的最近历史单价填入"
                      :data-act="`pue-fill-${r.uid}`"
                      @click="fillPrice(r)"
                    >
                      取最近价
                    </button>
                    <button
                      type="button"
                      class="wb-link wb-link--danger pue__oplink"
                      :data-act="`pue-delrow-${r.uid}`"
                      @click="removeRow(r.uid)"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="wb-empty" data-act="pue-empty">
            <p class="wb-empty__title">还没有明细行</p>
            <p class="wb-empty__desc">
              点「+ 加行」手工添，或者回「要拿什么」选好厂家，按清单一键生成一张。
            </p>
          </div>
        </template>
      </div>

      <div class="wb-dialog__foot pue__foot">
        <span class="pue__total">
          {{ footPrefix }}合计 <b data-act="pue-total">¥{{ money(totalCents) }}</b>
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
//    给一个改不动的下拉框属于"假动作"（项目明确禁止），故页头只给一个只读标签。
import { computed, onMounted, ref } from 'vue';
import { orderImageThumbBatch } from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import type { PurchaseOrder } from '@/types';
import { centsToYuan, money, priceHistory, styleImages, updateOrder, yuanToCents } from '../purchase';

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

/** 页脚前缀：包价单没有"行"的概念，只说合计（写"共 0 行"是错的） */
const footPrefix = computed(() => (isPackage.value ? '' : `共 ${rows.value.length} 行 · `));

/**
 * 行图：键 = `款编码|款色|尺码`。
 * ⚠️ **尺码是键的一部分**（2026-10-11 用户报"拿货单明细的图片都是一样的"）：订单 Excel 里
 * 每个商品行各有自己的图（落在 `oi_orders.image_id`），而明细行的粒度正是「款色 × 尺码」——
 * 只按款色取图 ⇒ 同一款的所有行（不同尺码、各来自不同商品）全显示成同一张，且多数还不是本行那件。
 * `imgPaths` 的值 `undefined` = 还没查过、`null` = 查过但没有 —— 两者必须分开，
 * 否则"还没查"会显示成"缺图"（打开瞬间整表闪一遍假缺图）。
 */
const imgPaths = ref<Record<string, string | null>>({});
/** 本地路径 → dataUrl（缩略图缓存） */
const thumbs = ref<Record<string, string>>({});

const pairKey = (styleCode: string, color: string, size: string): string =>
  `${styleCode.trim()}|${color.trim()}|${size.trim()}`;

function thumbOf(r: EditRow): string {
  const p = imgPaths.value[pairKey(r.styleCode, r.color, r.size)];
  return p ? thumbs.value[p] ?? '' : '';
}

/** 查过且确实没有图才给「缺图」占位；还没查过时留空位（不闪）。款编码没填 = 还没填，不算缺图 */
function resolvedNoImage(r: EditRow): boolean {
  if (!r.styleCode.trim()) return false;
  return imgPaths.value[pairKey(r.styleCode, r.color, r.size)] === null;
}

/**
 * 解析一组行的款色图（去重、跳过空款编码；只查还没查过的对）。
 * **失败静默**：图是装饰 —— 查不到/查挂了都只是空占位，绝不拦保存与单价这条主链路。
 */
async function resolveImages(pairs: { styleCode: string; color: string; size: string }[]): Promise<void> {
  const todo = new Map<string, { styleCode: string; color: string; size: string }>();
  for (const p of pairs) {
    if (!p.styleCode.trim()) continue;
    const key = pairKey(p.styleCode, p.color, p.size);
    if (key in imgPaths.value) continue;
    todo.set(key, p);
  }
  if (!todo.size) return;
  try {
    const entries = [...todo.entries()];
    const found = await styleImages({ items: entries.map(([, p]) => p) });
    const fresh: string[] = [];
    entries.forEach(([key], i) => {
      const path = found[i] ?? null;
      imgPaths.value[key] = path;
      if (path) fresh.push(path);
    });
    const missing = [...new Set(fresh.filter((p) => !thumbs.value[p]))];
    if (!missing.length) return;
    const t = await orderImageThumbBatch(missing.map((localPath) => ({ localPath, maxEdge: 96 })));
    if (!t.success) return;
    const urls = t.data?.dataUrls ?? [];
    missing.forEach((p, i) => {
      const url = urls[i];
      if (url) thumbs.value[p] = url;
    });
  } catch {
    /* 图是装饰：空着就行（下次改款色会再试），不打断录入 */
  }
}

onMounted(() => {
  void resolveImages(rows.value.map((r) => ({ styleCode: r.styleCode, color: r.color, size: r.size })));
});

function rowCents(r: EditRow): number {
  return Math.max(0, Math.round(Number(r.qty) || 0)) * yuanToCents(r.priceText);
}
const rowAmountCents = (r: EditRow): number => rowCents(r);

const totalCents = computed(() =>
  isPackage.value ? yuanToCents(packageYuan.value) : rows.value.reduce((s, r) => s + rowCents(r), 0)
);

/** 已提交单的警示语按模式分叉：包价单不涉及缺口与成本（同一条话写死会在包价单上说错） */
const submittedNotice = computed(() =>
  isPackage.value
    ? '这张单已提交：改动会立即影响厂家对账的金额（包价单不涉及拿货缺口与成本）。'
    : '这张单已提交：改动会立即影响对账金额、待拿货缺口与「算钱」里的成本。'
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
  // 图先刷新 —— 下面的"已有价就不查历史价"会早退，别让它顺带挡住取图
  void resolveImages([{ styleCode: r.styleCode, color: r.color, size: r.size }]);
  if (yuanToCents(r.priceText) > 0) return;
  const cents = await priceHistory({
    supplierId: props.order.supplierId,
    styleCode: r.styleCode.trim(),
    color: r.color.trim(),
  }).catch(() => 0);
  if (cents > 0) r.priceText = String(centsToYuan(cents));
}

/** 尺码改完只重查这一行的图 —— 尺码是取图键的一部分，但它与单价无关，**不碰历史价** */
function onSizeChange(r: EditRow): void {
  void resolveImages([{ styleCode: r.styleCode, color: r.color, size: r.size }]);
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
/* 抽屉加宽 560 → 620：560px 时内容区只有 527px，而 8 列明细表的固有宽度 658px ——
   「金额(元)」被裁半边、行尾操作列落在视窗外（静默不可达，2026-10-10 截图取证）。
   620px ⇒ 内容区 587px，配合下表列宽恰好一行放下。 */
.pue {
  width: 620px;
}

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
  gap: 10px;
}

/* 一行工具条：日期 + 提示 + 加行 */
.pue__bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pue__date {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.pue__date .wb-muted {
  font-size: 12px;
}

.pue__hint {
  flex: 1;
  min-width: 0;
  font-size: 12px;
}

.pue__pkg {
  max-width: 260px;
}

/* 列宽固定（colgroup）+ fixed 布局：数字列给足两位数小数，款色列吃剩余宽度。
   行 padding 收到 5px 压行高（原来 9px，行高 77px 读起来松垮） */
.pue__table {
  table-layout: fixed;
  width: 100%;
}

.pue__table th,
.pue__table td {
  padding: 5px 6px;
}

.pue__c-img {
  width: 48px;
}

/* 第二列（款色）不给宽度：吃掉剩余空间 */
.pue__c-size {
  width: 54px;
}

.pue__c-sug {
  width: 40px;
}

.pue__c-qty {
  width: 60px;
}

.pue__c-price {
  width: 80px;
}

.pue__c-amt {
  width: 76px;
}

.pue__c-ops {
  /* 66px = 「取最近价」12px 文字 + 链接内边距 + 单元格 4px 内边距（60px 会把它挤断行） */
  width: 66px;
}

/* 行悬浮：横着扫 8 列时"这行是谁"要跟得住。
   连同首格（sticky 列自带底色，不换色会在横滚时断层）一起换。 */
.pue__table tbody tr:hover td {
  background: var(--wb-hover);
}

/* 实拿/单价：输入框撑满单元格（不撑满看着像装饰）；尺码也用它控宽（外观另由 .pue__ghost 管） */
.pue__cell {
  width: 100%;
  min-width: 0;
}

/* 款色 / 尺码 = **身份数据**（清单带过来的），默认看起来是文字：无边框、无底色；
   悬浮只出一条边框提示"可点"；聚焦才还原成完整输入框。
   （2026-10-10 用户反馈："款色和尺码为什么要用输入框的样式？" —— 满屏方框会被读成
   "这里全都要我填"。）
   ⚠️ 用 :focus 而不是 :focus-visible：它常态长得像纯文字，鼠标点进去若不还原输入框外观，
      等于没有任何"我正在编辑"的反馈（基座的 :focus-visible 只服务键盘 Tab）。 */
.pue__ghost {
  border-color: transparent;
  background-color: transparent;
}

.pue__ghost:hover {
  border-color: var(--wb-border);
}

.pue__ghost:focus {
  border-color: var(--wb-focus);
  box-shadow: 0 0 0 3px var(--wb-focus-ring);
  background-color: var(--wb-surface-2);
}

.pue__imgcell {
  width: 48px;
}

/* 行图：36px 方图；查过没有才显示「缺图」，未查过留空 */
.pue__thumb {
  display: block;
  width: 36px;
  height: 36px;
  object-fit: cover;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
}

.pue__noimg {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px dashed var(--wb-border);
  border-radius: var(--wb-radius-sm);
  font-size: 10px;
  color: var(--wb-text-muted);
}

/* 款色 = 款编码 + 颜色（两个输入一行，placeholder 认字段，不再用「·」占位）＋ 款名灰字一行 */
.pue__style {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pue__code {
  flex: 0 1 92px;
  min-width: 56px;
}

.pue__color {
  flex: 1 1 58px;
  min-width: 0;
}

.pue__name {
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--wb-text-muted);
}

/* 行尾文字按钮「取最近价 / 删除」竖排两行（与「拿了什么」列表同一套 .wb-link）。
   12px：.wb-link 基座 13px 时「取最近价」宽 60px，塞不进 66px 列。
   ⚠️ 覆盖 td 的 5px/6px 内边距要连 .pue__table 一起写（`.pue__table td` 是 0-1-1，压过单个类）。 */
.pue__table .pue__ops {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 4px;
}

.pue__oplink {
  font-size: 12px;
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
