<template>
  <div v-if="visible" class="wb-mask pd-mask" data-act="pd-mask" @click.self="close">
    <aside class="wb-drawer pd" data-act="pd-drawer">
      <div class="wb-dialog__head">
        <span>拆包 · <span class="wb-mono">{{ orderNo }}</span></span>
        <span class="pd-head-totals" data-act="pd-totals">{{ totalsText }}</span>
        <button type="button" class="wb-link pd-close" data-act="pd-close" @click="close">关闭</button>
      </div>

      <div class="wb-dialog__body">
        <div v-if="loading" class="wb-empty"><p class="wb-empty__title">正在读取这单的包裹…</p></div>
        <template v-else>
          <div v-if="errorText" class="wb-notice wb-notice--error" data-act="pd-error">{{ errorText }}</div>

          <!-- ── 商品行：这一单买了什么、还能拆几件 ──────────────────────────────
               ⚠️ 「件数未知」必须**说出来**（`qty = null`）：导入侧没解析出件数时，
                  上限就是不知道，界面不能自己按 1 件算（那样第二个包永远放不进去）。 -->
          <section class="pd-block">
            <h4 class="pd-block__title">这单的商品行</h4>
            <table class="pd-table">
              <thead>
                <tr>
                  <th>款色</th>
                  <th>尺码</th>
                  <th class="pd-num">件数</th>
                  <th class="pd-num">已分包</th>
                  <th class="pd-num">还能拆</th>
                  <th>放入包裹</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="it in items" :key="it.id" :data-act="`pd-item-${it.id}`">
                  <td>{{ it.styleColor || it.color || '未归类' }}</td>
                  <td>{{ it.size || '—' }}</td>
                  <td class="pd-num">{{ it.qty === null ? '未知' : it.qty }}</td>
                  <td class="pd-num">{{ it.packed }}</td>
                  <td class="pd-num" :class="{ 'pd-warn': it.remaining === 0 }">
                    {{ it.remaining === null ? '—' : it.remaining }}
                  </td>
                  <td class="pd-add">
                    <select
                      v-model.number="pick[it.id].parcelId"
                      class="wb-input wb-input--sm"
                      :data-act="`pd-item-parcel-${it.id}`"
                    >
                      <option :value="0">选包裹</option>
                      <option v-for="p in parcels" :key="p.id" :value="p.id">
                        {{ p.label || `包 ${p.id}` }}
                      </option>
                    </select>
                    <input
                      v-model.number="pick[it.id].qty"
                      type="number"
                      min="1"
                      class="wb-input wb-input--sm pd-qty"
                      :data-act="`pd-item-qty-${it.id}`"
                    />
                    <button
                      type="button"
                      class="wb-link"
                      :data-act="`pd-item-add-${it.id}`"
                      :disabled="busy || !pick[it.id].parcelId || !(pick[it.id].qty > 0)"
                      @click="addLine(it)"
                    >
                      加入
                    </button>
                  </td>
                </tr>
                <tr v-if="!items.length">
                  <td colspan="6" class="pd-empty">这单在订单库里没有商品行（可能刚被清空）。</td>
                </tr>
              </tbody>
            </table>
          </section>

          <!-- ── 包裹 ──────────────────────────────────────────────────────── -->
          <section class="pd-block">
            <h4 class="pd-block__title">
              包裹（{{ parcels.length }}）
              <button
                type="button"
                class="wb-btn wb-btn--primary pd-new"
                data-act="pd-new"
                :disabled="busy || !items.length"
                @click="createParcel"
              >
                新建包裹
              </button>
            </h4>

            <p v-if="!parcels.length" class="pd-empty">
              还没有包裹。一单可以拆多个包：先「新建包裹」，再把上面商品行的件数放进去（一个行的数量可以拆到两个包里）。
            </p>

            <article v-for="(p, idx) in parcels" :key="p.id" class="pd-card" :data-act="`pd-parcel-${p.id}`">
              <header class="pd-card__head">
                <strong class="pd-card__name">{{ p.label || `包 ${idx + 1}` }}</strong>
                <span class="pd-card__sum" :data-act="`pd-parcel-sum-${p.id}`">{{ parcelSumText(p) }}</span>
                <button
                  type="button"
                  class="wb-link pd-danger"
                  :data-act="`pd-del-${p.id}`"
                  :disabled="busy"
                  @click="removeParcel(p)"
                >
                  删除
                </button>
              </header>

              <div class="pd-fields">
                <label class="wb-field">
                  <span class="wb-field__label">包名</span>
                  <input
                    v-model="drafts[p.id].label"
                    class="wb-input wb-input--sm"
                    :data-act="`pd-label-${p.id}`"
                    placeholder="箱 1 / 补发"
                    @blur="saveField(p, 'label')"
                  />
                </label>
                <label class="wb-field">
                  <span class="wb-field__label">运单号</span>
                  <input
                    v-model="drafts[p.id].trackingNo"
                    class="wb-input wb-input--sm"
                    :data-act="`pd-tracking-${p.id}`"
                    @blur="saveField(p, 'trackingNo')"
                  />
                </label>
                <label class="wb-field">
                  <span class="wb-field__label">承运</span>
                  <input
                    v-model="drafts[p.id].carrier"
                    class="wb-input wb-input--sm"
                    :data-act="`pd-carrier-${p.id}`"
                    placeholder="如 燕文"
                    @blur="saveField(p, 'carrier')"
                  />
                </label>
                <label class="wb-field">
                  <span class="wb-field__label">运费（元）</span>
                  <input
                    v-model="drafts[p.id].shipYuan"
                    class="wb-input wb-input--sm"
                    :data-act="`pd-ship-${p.id}`"
                    inputmode="decimal"
                    placeholder="没填 = 还不知道"
                    @blur="saveField(p, 'shipCents')"
                  />
                </label>
                <label class="wb-field">
                  <span class="wb-field__label">重量（克）</span>
                  <input
                    v-model="drafts[p.id].weightG"
                    class="wb-input wb-input--sm"
                    :data-act="`pd-weight-${p.id}`"
                    inputmode="numeric"
                    placeholder="没填 = 还不知道"
                    @blur="saveField(p, 'weightG')"
                  />
                </label>
              </div>

              <table class="pd-table pd-table--inner">
                <thead>
                  <tr>
                    <th>箱内商品</th>
                    <th class="pd-num">件数</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="l in p.lines" :key="l.id" :data-act="`pd-line-${l.id}`">
                    <td>{{ itemLabel(l.orderItemId) }}</td>
                    <td class="pd-num">
                      <input
                        :value="l.qty"
                        type="number"
                        min="0"
                        class="wb-input wb-input--sm pd-qty"
                        :data-act="`pd-line-qty-${l.id}`"
                        @change="setLineQty(p, l.orderItemId, $event)"
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        class="wb-link pd-danger"
                        :data-act="`pd-line-del-${l.id}`"
                        :disabled="busy"
                        @click="setLineQtyValue(p.id, l.orderItemId, 0)"
                      >
                        移出
                      </button>
                    </td>
                  </tr>
                  <tr v-if="!p.lines.length">
                    <td colspan="3" class="pd-empty">这个包还空着。</td>
                  </tr>
                </tbody>
              </table>
            </article>
          </section>
        </template>
      </div>

      <div class="wb-dialog__foot">
        <span class="pd-foot-hint">改完即存（失焦保存）；件数改 0 = 从该包移出。</span>
        <button type="button" class="wb-btn" data-act="pd-done" @click="close">完成</button>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
// 拆包抽屉（2026-10-21，订单-采购模型简化 B2）。
//
// **它解决什么**：一单可能装成多个包（重量/运费按包算），一个商品行的件数也可能拆到两个包里。
// 数据在 `parcels` / `parcel_lines`（主进程 `order-db` 唯一写入口）。
//
// 三条界面口径（改之前先读）：
//   ① **不做本地状态机**：每次写成功都用主进程回的**整单最新状态**重绘（`apply()`）。
//      拆包这件事天然是"多个包互相挤件数"，本地推测的结果和库不一致时，用户看到的是
//      "我明明点了保存" —— 这类假成功在这个仓里已经踩过多次。
//   ② **空 ≠ 0**：运费/重量留空就是"还不知道"（落库 NULL），没填的包会让整单汇总显示
//      "还有 N 个包没填"，而不是按已知部分之和报一个看起来正常的数（那是把缺数据算成 0 元）。
//   ③ **超拆由主进程拒绝**：本组件不自己算"还能放几件"（只在商品行上显示主进程给的
//      `remaining`），拒绝理由原样展示。两处各减一遍必然有一天不一致。
import { reactive, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import * as ipc from '@/core/services/ipc';
import type { Parcel, ParcelDetail, ParcelItem } from '@/types';

const props = defineProps<{ visible: boolean; orderNo: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const loading = ref(false);
const busy = ref(false);
const errorText = ref('');
const parcels = ref<Parcel[]>([]);
const items = ref<ParcelItem[]>([]);
const totals = ref<ParcelDetail['totals'] | null>(null);

/** 每个包的编辑草稿（元/克用字符串，避免 `v-model.number` 把空串变成 0） */
interface Draft {
  label: string;
  trackingNo: string;
  carrier: string;
  shipYuan: string;
  weightG: string;
}
const drafts = reactive<Record<number, Draft>>({});

/** 商品行 → 想放进哪个包 / 放几件 */
const pick = reactive<Record<number, { parcelId: number; qty: number }>>({});

function centsToYuan(cents: number | null): string {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);
}

/** 元字符串 → 分。空 = 还不知道（null）；非数字返回 undefined（= 不改，别把用户正在输入的东西冲成 null） */
function yuanToCents(s: string): number | null | undefined {
  const t = String(s ?? '').trim();
  if (t === '') return null;
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return undefined;
  return Math.round(Number(t) * 100);
}

function itemLabel(orderItemId: number): string {
  const it = items.value.find((x) => x.id === orderItemId);
  if (!it) return `行 #${orderItemId}`;
  const name = it.styleColor || it.color || '未归类';
  return it.size ? `${name} / ${it.size}` : name;
}

function parcelSumText(p: Parcel): string {
  const qty = p.lines.reduce((s, l) => s + l.qty, 0);
  const ship = p.shipCents === null ? '运费未填' : `运费 ¥${(p.shipCents / 100).toFixed(2)}`;
  const w = p.weightG === null ? '重量未填' : `${p.weightG} g`;
  return `${qty} 件 · ${ship} · ${w}`;
}

const totalsText = ref('');
function refreshTotalsText() {
  const t = totals.value;
  if (!t || !t.count) {
    totalsText.value = '还没拆包';
    return;
  }
  const ship =
    t.shipCents === null ? `运费：还有 ${t.shipMissing} 个包没填` : `运费 ¥${(t.shipCents / 100).toFixed(2)}`;
  const w = t.weightG === null ? `重量：还有 ${t.weightMissing} 个包没填` : `${t.weightG} g`;
  totalsText.value = `${t.count} 包 · ${ship} · ${w}`;
}

/** 用主进程返回的整单状态重绘（**唯一**的重绘入口，见文件头口径①） */
function apply(d: ParcelDetail | null | undefined) {
  if (!d) return;
  parcels.value = d.parcels;
  items.value = d.items;
  totals.value = d.totals;
  refreshTotalsText();
  for (const p of d.parcels) {
    drafts[p.id] = {
      label: p.label,
      trackingNo: p.trackingNo,
      carrier: p.carrier,
      shipYuan: centsToYuan(p.shipCents),
      weightG: p.weightG === null ? '' : String(p.weightG),
    };
  }
  for (const it of d.items) {
    const cur = pick[it.id];
    const keepParcel = cur && d.parcels.some((p) => p.id === cur.parcelId) ? cur.parcelId : 0;
    pick[it.id] = { parcelId: keepParcel, qty: it.remaining === null ? 1 : Math.max(it.remaining, 1) };
  }
}

async function load() {
  const no = props.orderNo;
  if (!no) return;
  loading.value = true;
  errorText.value = '';
  const r = await ipc.orderParcelDetail(no);
  loading.value = false;
  if (!r.success) {
    errorText.value = r.error || '读取失败';
    return;
  }
  apply(r.data);
}

watch(
  () => [props.visible, props.orderNo] as const,
  ([vis]) => {
    if (vis) void load();
  },
  { immediate: true },
);

function fail(msg: string) {
  errorText.value = msg;
  toast(msg, 'error');
}

async function createParcel() {
  busy.value = true;
  errorText.value = '';
  const r = await ipc.orderParcelCreate({ orderNo: props.orderNo });
  busy.value = false;
  if (!r.success) return fail(r.error || '新建包裹失败');
  apply(r.data);
}

async function removeParcel(p: Parcel) {
  const label = p.label || `包 ${p.id}`;
  if (!window.confirm(`删除「${label}」？箱内商品会回到未分包（商品行本身不受影响）。`)) return;
  busy.value = true;
  errorText.value = '';
  const r = await ipc.orderParcelDelete({ id: p.id, orderNo: props.orderNo });
  busy.value = false;
  if (!r.success) return fail(r.error || '删除包裹失败');
  apply(r.data);
}

/** 失焦保存一个字段：只在**改动过**时发，且只发这一个字段（别拿整份草稿去覆盖别人刚填的格） */
async function saveField(p: Parcel, field: 'label' | 'trackingNo' | 'carrier' | 'shipCents' | 'weightG') {
  const d = drafts[p.id];
  if (!d) return;
  const payload: {
    id: number;
    orderNo: string;
    label?: string;
    trackingNo?: string;
    carrier?: string;
    shipCents?: number | null;
    weightG?: number | null;
  } = { id: p.id, orderNo: props.orderNo };
  if (field === 'label') {
    if (d.label === p.label) return;
    payload.label = d.label;
  } else if (field === 'trackingNo') {
    if (d.trackingNo === p.trackingNo) return;
    payload.trackingNo = d.trackingNo;
  } else if (field === 'carrier') {
    if (d.carrier === p.carrier) return;
    payload.carrier = d.carrier;
  } else if (field === 'shipCents') {
    const cents = yuanToCents(d.shipYuan);
    // `undefined` = 格式不认识 ⇒ 不改（也不把用户正在敲的 "1." 当成清空）
    if (cents === undefined) {
      d.shipYuan = centsToYuan(p.shipCents);
      return fail('运费要填成 0.00 这样的数字（留空 = 还不知道）');
    }
    if (cents === p.shipCents) return;
    payload.shipCents = cents;
  } else {
    const t = String(d.weightG ?? '').trim();
    if (t !== '' && !/^\d+$/.test(t)) {
      d.weightG = p.weightG === null ? '' : String(p.weightG);
      return fail('重量要填整数克（留空 = 还不知道）');
    }
    const g = t === '' ? null : Number(t);
    if (g === p.weightG) return;
    payload.weightG = g;
  }
  busy.value = true;
  errorText.value = '';
  const r = await ipc.orderParcelUpdate(payload);
  busy.value = false;
  if (!r.success) return fail(r.error || '保存失败');
  apply(r.data);
}

async function addLine(it: ParcelItem) {
  const p = pick[it.id];
  if (!p?.parcelId) return;
  const qty = Math.round(Number(p.qty));
  if (!Number.isFinite(qty) || qty <= 0) return fail('件数要填 1 以上的整数');
  await setLineQtyValue(p.parcelId, it.id, qty);
}

function setLineQty(p: Parcel, orderItemId: number, ev: Event) {
  const v = Number((ev.target as HTMLInputElement).value);
  void setLineQtyValue(p.id, orderItemId, Number.isFinite(v) ? Math.round(v) : 0);
}

async function setLineQtyValue(parcelId: number, orderItemId: number, qty: number) {
  busy.value = true;
  errorText.value = '';
  const r = await ipc.orderParcelSetLine({
    parcelId,
    orderItemId,
    qty,
    orderNo: props.orderNo,
  });
  busy.value = false;
  if (!r.success) {
    // ⚠️ 顺序不能反：`load()` 开头会把 `errorText` 清空，所以**先回读、再挂理由**。
    //    反过来写的话，拒绝理由只亮一瞬就被回读抹掉 —— 界面看起来"点了没反应"，
    //    而用户恰恰最需要那句话（"最多还能放 1 件"）。这坑是 `today:ui` 冒烟抓到的。
    const msg = r.error || '拆包失败';
    await load();
    errorText.value = msg;
    toast(msg, 'error');
    return;
  }
  apply(r.data);
}

function close() {
  emit('close');
}
</script>

<style scoped>
.pd {
  width: 720px;
}
.pd-mask {
  justify-content: flex-end;
}
.pd-head-totals {
  margin-left: auto;
  font-size: 12px;
  font-weight: 400;
  color: var(--wb-text-muted);
}
.pd-close {
  margin-left: 8px;
}
.pd-block {
  margin-bottom: 18px;
}
.pd-block__title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
}
.pd-new {
  margin-left: auto;
}
.pd-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.pd-table th,
.pd-table td {
  padding: 5px 6px;
  border-bottom: 1px solid var(--wb-border);
  text-align: left;
  vertical-align: middle;
}
.pd-table th {
  font-weight: 500;
  color: var(--wb-text-muted);
}
.pd-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pd-warn {
  color: var(--wb-text-muted);
}
.pd-add {
  display: flex;
  gap: 4px;
  align-items: center;
}
.pd-qty {
  width: 58px;
}
.pd-empty {
  padding: 10px 2px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-text-muted);
}
.pd-card {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}
.pd-card__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.pd-card__name {
  font-size: 13px;
}
.pd-card__sum {
  font-size: 12px;
  color: var(--wb-text-muted);
}
.pd-card__head .pd-danger {
  margin-left: auto;
}
.pd-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 10px;
  margin-bottom: 8px;
}
.pd-danger {
  color: var(--wb-danger);
}
.pd-foot-hint {
  margin-right: auto;
  font-size: 12px;
  color: var(--wb-text-muted);
}
</style>
