<template>
  <div class="wb-page rc-view" data-act="recon-panel">
    <!-- 指标条：**全是金额**，且同一口径（同一时间窗、同一张表算出来的四个数 —— 相减才有意义）。
         ⚠️ 每格必须是「标签 + 空格 + <b>值</b>」同一串文本（冒烟按 textContent 取子串）。 -->
    <div class="wb-metabar rc-stats" data-act="rc-stats">
      <span class="wb-metric">拿货 <b>¥{{ money(sum.purchase) }}</b></span>
      <span class="wb-metric">已付 <b>¥{{ money(sum.paid) }}</b></span>
      <span class="wb-metric">已退 <b>¥{{ money(sum.refund) }}</b></span>
      <span class="wb-metric" :class="{ 'is-warn': sum.balance > 0 }" data-act="rc-metric-balance">
        欠款 <b>¥{{ money(sum.balance) }}</b>
      </span>
    </div>

    <!-- 时间窗 + 视图切换。两者都是"看哪一段账"的口径，放同一行。 -->
    <div class="rc-bar">
      <div class="wb-seg" data-act="rc-range">
        <button
          v-for="r in RECON_RANGES"
          :key="r.id"
          type="button"
          class="wb-seg__item"
          :class="{ 'is-on': range === r.id }"
          :data-act="`rc-range-${r.id}`"
          @click="setRange(r.id)"
        >
          {{ r.label }}
        </button>
      </div>
      <template v-if="range === 'custom'">
        <input v-model="customFrom" type="date" class="wb-input wb-input--sm" data-act="rc-from" />
        <span class="wb-muted">~</span>
        <input v-model="customTo" type="date" class="wb-input wb-input--sm" data-act="rc-to" />
      </template>
      <span class="rc-grow"></span>
      <div class="wb-seg" data-act="rc-views">
        <button
          type="button"
          class="wb-seg__item"
          :class="{ 'is-on': view === 'supplier' }"
          data-act="rc-view-supplier"
          @click="view = 'supplier'"
        >
          按厂家
        </button>
        <button
          type="button"
          class="wb-seg__item"
          :class="{ 'is-on': view === 'shop' }"
          data-act="rc-view-shop"
          @click="view = 'shop'"
        >
          按店铺
        </button>
      </div>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error" data-act="rc-error">{{ error }}</p>

    <!-- ============ 视图 A：按厂家（结算 + 付款） ============ -->
    <template v-if="view === 'supplier'">
      <section class="wb-panel">
        <div class="wb-panel__head">
          <span>厂家对账</span>
          <span class="wb-muted">差额 = 拿货 −（已付 − 退款）· 窗口「{{ rangeText }}」</span>
          <span class="rc-actions">
            <button type="button" class="wb-btn wb-btn--sm" data-act="rc-reload" :disabled="loading" @click="load">
              刷新
            </button>
          </span>
        </div>
        <div v-if="recon.length" class="wb-panel__body wb-table-wrap">
          <table class="wb-table" data-act="rc-table">
            <thead>
              <tr>
                <th>厂家</th>
                <th>拿货单 / 付款</th>
                <th class="wb-num">拿货</th>
                <th class="wb-num">已付</th>
                <th class="wb-num">已退</th>
                <th class="wb-num">差额</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in recon" :key="r.supplierId">
                <td>{{ r.supplierName || '—' }}</td>
                <td class="wb-muted">{{ r.orderCount }} 单 / {{ r.paymentCount }} 笔</td>
                <td class="wb-num">¥{{ money(r.purchaseCents) }}</td>
                <td class="wb-num">¥{{ money(r.paidCents) }}</td>
                <td class="wb-num">¥{{ money(r.refundCents) }}</td>
                <td class="wb-num" :class="Number(r.balanceCents) > 0 ? 'rc-debt' : 'rc-clear'">
                  ¥{{ money(r.balanceCents) }}
                </td>
                <td>
                  <button
                    type="button"
                    class="wb-link"
                    :data-act="`rc-pay-${r.supplierId}`"
                    @click="openPay(r.supplierId)"
                  >
                    记付款
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="wb-empty" data-act="rc-recon-none">
          <p class="wb-empty__title">这个窗口里没有账</p>
          <p class="wb-empty__desc">
            对账的两个来源是「拿货单」（欠厂家多少）与「付款记录」（已付多少）。窗口切到「全部」看历史，
            或者先去第 5 步「拿货」把拿货单开出来。
          </p>
          <div class="wb-empty__actions">
            <button type="button" class="wb-btn" data-act="rc-goto-purchase" @click="go('purchase')">
              去拿货
            </button>
          </div>
        </div>
      </section>

      <section class="wb-panel">
        <div class="wb-panel__head">
          <span>付款记录</span>
          <span class="wb-muted">按付款日期；登记后立即进入上面的对账</span>
          <span class="rc-actions">
            <button
              type="button"
              class="wb-btn wb-btn--sm wb-btn--primary"
              data-act="rc-pay-new"
              :disabled="!suppliers.length"
              @click="openPay(0)"
            >
              登记付款
            </button>
          </span>
        </div>
        <div v-if="payments.length" class="wb-panel__body wb-table-wrap">
          <table class="wb-table" data-act="rc-pay-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>厂家</th>
                <th>类型</th>
                <th class="wb-num">金额</th>
                <th>方式</th>
                <th>备注</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in payments" :key="p.id">
                <td>{{ p.payDate }}</td>
                <td>{{ p.supplierName || '—' }}</td>
                <td>
                  <span class="wb-tag" :class="p.type === 'refund' ? 'is-warn' : 'is-on'">
                    {{ p.type === 'refund' ? '退款' : '付款' }}
                  </span>
                </td>
                <td class="wb-num">¥{{ money(p.amountCents) }}</td>
                <td class="wb-muted">{{ p.method || '—' }}</td>
                <td class="wb-muted">{{ p.note || '—' }}</td>
                <td>
                  <button
                    type="button"
                    class="wb-link wb-link--danger"
                    :data-act="`rc-pay-del-${p.id}`"
                    @click="askDeletePayment(p)"
                  >
                    删除
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="wb-empty" data-act="rc-pay-none">
          <p class="wb-empty__title">还没有付款记录</p>
          <p class="wb-empty__desc">
            跟厂家结过钱就记一笔（金额 / 方式 / 备注都随意），对账表的「已付」与「欠款」由它算出来。
          </p>
        </div>
      </section>
    </template>

    <!-- ============ 视图 B：按店铺（拿货成本分摊） ============ -->
    <section v-else class="wb-panel">
      <div class="wb-panel__head">
        <span>店铺分摊</span>
        <span class="wb-muted">
          拿货成本按拿货单锁定的来源订单（店铺 / 款色 / 件数）拆分；窗口「{{ rangeText }}」
        </span>
      </div>
      <div v-if="shopRows.length" class="wb-panel__body wb-table-wrap">
        <table class="wb-table" data-act="rc-shop-table">
          <thead>
            <tr>
              <th class="rc-shop-col">店铺</th>
              <th>拿货单</th>
              <th class="wb-num">件数</th>
              <th class="wb-num">成本</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="s in shopRows" :key="s.shop">
              <tr>
                <td>{{ s.shop || '（未归属）' }}</td>
                <td class="wb-muted">{{ s.orderCount }} 单</td>
                <td class="wb-num">{{ s.qty }}</td>
                <td class="wb-num">¥{{ money(s.amountCents) }}</td>
                <td>
                  <button
                    type="button"
                    class="wb-link"
                    :data-act="`rc-shop-toggle-${s.shop}`"
                    @click="toggleShop(s.shop)"
                  >
                    {{ openShop === s.shop ? '收起' : '明细' }}
                  </button>
                </td>
              </tr>
              <tr v-if="openShop === s.shop">
                <td colspan="5" class="rc-detail-cell">
                  <table v-if="shopDetail.length" class="wb-table rc-detail" data-act="rc-shop-detail">
                    <thead>
                      <tr>
                        <th>日期</th>
                        <th>厂家</th>
                        <th>款编码</th>
                        <th>款色</th>
                        <th>码</th>
                        <th class="wb-num">件</th>
                        <th class="wb-num">单价</th>
                        <th class="wb-num">金额</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(l, i) in shopDetail" :key="i">
                        <td class="wb-muted">{{ l.bizDate }}</td>
                        <td class="wb-muted">{{ l.supplierName || '—' }}</td>
                        <td class="wb-mono">{{ l.styleCode || '—' }}</td>
                        <td>{{ l.color || '—' }}</td>
                        <td>{{ l.size || '—' }}</td>
                        <td class="wb-num">{{ l.qty }}</td>
                        <td class="wb-num wb-muted">{{ money(l.priceCents) }}</td>
                        <td class="wb-num">¥{{ money(l.amountCents) }}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p v-else class="wb-muted">该店铺在这个窗口内没有拿货明细。</p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div v-else class="wb-empty" data-act="rc-shop-none">
        <p class="wb-empty__title">还没有可归属店铺的拿货成本</p>
        <p class="wb-empty__desc">
          分摊的原料是「拿货单锁定来源订单」这件事：先在「算钱」把订单归属到店铺，
          再从「拿货」按缺口生成拿货单，成本就会拆到店铺。
        </p>
      </div>
    </section>

    <!-- 记付款弹层（厂家在新窗口里预选好，省掉再一次选择） -->
    <div v-if="payDlg" class="wb-mask" @click.self="payDlg = false">
      <div class="wb-dialog wb-dialog--sm" role="dialog" aria-modal="true" data-act="rc-pay-dialog">
        <div class="wb-dialog__head">登记一笔款项</div>
        <div class="wb-dialog__body">
          <label class="wb-field rc-field">
            <span class="wb-field__label">厂家</span>
            <select v-model.number="pay.supplierId" class="wb-input" data-act="rc-pay-supplier">
              <option :value="0">选择厂家…</option>
              <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </label>
          <label class="wb-field rc-field">
            <span class="wb-field__label">类型</span>
            <select v-model="pay.type" class="wb-input" data-act="rc-pay-type">
              <option value="payment">付款（我付给厂家）</option>
              <option value="refund">退款（厂家退给我）</option>
            </select>
          </label>
          <label class="wb-field rc-field">
            <span class="wb-field__label">金额（元）</span>
            <input v-model="pay.amount" class="wb-input" data-act="rc-pay-amount" placeholder="如 1280.00" />
          </label>
          <label class="wb-field rc-field">
            <span class="wb-field__label">日期</span>
            <input v-model="pay.payDate" type="date" class="wb-input" data-act="rc-pay-date" />
          </label>
          <label class="wb-field rc-field">
            <span class="wb-field__label">方式（选填）</span>
            <input v-model="pay.method" class="wb-input" data-act="rc-pay-method" placeholder="微信 / 支付宝 / 银行" />
          </label>
          <label class="wb-field rc-field">
            <span class="wb-field__label">备注（选填）</span>
            <input v-model="pay.note" class="wb-input" data-act="rc-pay-note" />
          </label>
        </div>
        <div class="wb-dialog__foot">
          <button type="button" class="wb-btn" data-act="rc-pay-cancel" :disabled="busy" @click="payDlg = false">
            取消
          </button>
          <button
            type="button"
            class="wb-btn wb-btn--primary"
            data-act="rc-pay-ok"
            :disabled="busy"
            @click="submitPay"
          >
            {{ busy ? '登记中…' : '登记' }}
          </button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-if="confirm"
      :title="confirm.title"
      :confirm-text="confirm.okText"
      :danger="confirm.danger"
      :busy="busy"
      @close="confirm = null"
      @confirm="runConfirm"
    >
      <p v-for="(line, i) in confirm.body" :key="i">{{ line }}</p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
// 「结算对账」页签 = 发货流程第 6 步（2026-10-05 从「订单归类」岛的「拿货对账」页内建过来）。
//
// **这一步回答两个问题**：① 这个窗口里我欠厂家多少（拿货 − 已付 + 退款）；② 这些拿货成本
// 落在哪个店铺上。前者是"结算"，后者是"分摊"，所以按**视图**切换而不是两个页签 ——
// 它们是同一批数据的两个切面，不是两件事。
//
// **照功能不照样式**：移植自原「订单归类」岛的**拿货对账页**（该岛已于 2026-10-05 整体下架，
// 源码留档不入库，`CHANGELOG.md` 的 Removed 段有清单）—— 原页用自己的 `.panel/.bar/.btn`；
// 内建页一律走 `.wb-*`。
//
// 金额口径**只在主进程算**（`electron/purchase-db.ts` 的 `reconciliation` / `shopAllocation`），
// 本页只做"分 → 元"的显示换算（`money`）—— 同屏并列的四个金额必须同源，否则相减出来的欠款是错的。
//
// **这一次砍掉了什么（"哪些在流程里有用的"的裁量，2026-10-05）**：
//   · **导出 Excel** —— 宿主现成的导出通道（`purchaseExportExcel`）是按**拿货单明细行**导出的
//     （带款色图、按厂家分表），不是"把任意表格倒成 xlsx"。要导对账汇总得新开一条通道，
//     而对账数字屏幕上看得见、也不属于每日动作 ⇒ 不造这个按钮（岛里那个点了其实是被宿主拒的）。
//   · **厂家增删改** —— 供应商是主数据，维护在「货与成本 › 供应商」；本页只读引用。
//   · 岛里的**待拿货缺口 / 拿货单**两块 —— 它们是第 5 步「拿货」的事，岛把它们和付款挤在一页，
//     本页按流程拆开了（页签各管一步）。
import { computed, onMounted, reactive, ref, watch } from 'vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import { toast } from '@/core/services/toast';
import type { Payment, ReconciliationRow, ShopAllocationDetailRow, ShopAllocationRow, Supplier } from '@/types';
import { useShipping } from '../flowCtx';
import {
  RECON_RANGES,
  addPayment,
  defaultCustomRange,
  deletePayment,
  listPayments,
  listSuppliers,
  money,
  rangeLabel,
  reconciliation,
  shopAllocation,
  shopAllocationDetail,
  windowOf,
  yuanToCents,
  type ReconRange,
} from '../purchase';

const { token, go, bump } = useShipping();

const loading = ref(false);
const busy = ref(false);
const error = ref('');

const view = ref<'supplier' | 'shop'>('supplier');
const range = ref<ReconRange>('all');
const customFrom = ref('');
const customTo = ref('');

const recon = ref<ReconciliationRow[]>([]);
const payments = ref<Payment[]>([]);
const suppliers = ref<Supplier[]>([]);
const shopRows = ref<ShopAllocationRow[]>([]);
const openShop = ref('');
const shopDetail = ref<ShopAllocationDetailRow[]>([]);

const sum = computed(() =>
  recon.value.reduce(
    (a, r) => {
      a.purchase += Number(r.purchaseCents) || 0;
      a.paid += Number(r.paidCents) || 0;
      a.refund += Number(r.refundCents) || 0;
      a.balance += Number(r.balanceCents) || 0;
      return a;
    },
    { purchase: 0, paid: 0, refund: 0, balance: 0 }
  )
);

const rangeText = computed(() => rangeLabel(range.value, customFrom.value, customTo.value));

// ─────────────────────────────────────────────── 记付款弹层

const payDlg = ref(false);
const pay = reactive({ supplierId: 0, type: 'payment' as 'payment' | 'refund', amount: '', payDate: '', method: '', note: '' });

/** 打开记付款：`supplierId > 0` 时预选该厂家（从对账行点进来的场景） */
function openPay(supplierId: number): void {
  pay.supplierId = supplierId || 0;
  pay.type = 'payment';
  pay.amount = '';
  pay.payDate = new Date().toISOString().slice(0, 10);
  pay.method = '';
  pay.note = '';
  payDlg.value = true;
}

async function submitPay(): Promise<void> {
  if (!pay.supplierId) return toast('先选一个厂家', 'error');
  const cents = yuanToCents(pay.amount);
  if (!cents) return toast('金额要大于 0', 'error');
  busy.value = true;
  try {
    await addPayment({
      supplierId: pay.supplierId,
      payDate: pay.payDate,
      type: pay.type,
      amountCents: cents,
      method: pay.method.trim(),
      note: pay.note.trim(),
    });
    payDlg.value = false;
    toast(pay.type === 'refund' ? '已登记退款' : '已登记付款', 'success');
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '登记失败', 'error');
  } finally {
    busy.value = false;
  }
}

// ─────────────────────────────────────────────── 删除付款

type ConfirmSpec = { title: string; body: string[]; okText: string; danger: boolean; run: () => Promise<void> };
const confirm = ref<ConfirmSpec | null>(null);

function askDeletePayment(p: Payment): void {
  confirm.value = {
    title: '删除这笔款项？',
    body: [
      `${p.payDate} · ${p.supplierName || '（无厂家）'} · ¥${money(p.amountCents)}`,
      '删除后对账表里的「已付」（或「已退」）会同步减少，欠款随之回升。',
    ],
    okText: '删除',
    danger: true,
    run: async () => {
      await deletePayment(p.id);
      toast('已删除', 'success');
      bump();
    },
  };
}

async function runConfirm(): Promise<void> {
  const spec = confirm.value;
  if (!spec) return;
  busy.value = true;
  try {
    await spec.run();
    confirm.value = null;
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '操作失败', 'error');
  } finally {
    busy.value = false;
  }
}

// ─────────────────────────────────────────────── 取数

function setRange(r: ReconRange): void {
  range.value = r;
  if (r === 'custom' && !customFrom.value && !customTo.value) {
    const d = defaultCustomRange();
    customFrom.value = d.from;
    customTo.value = d.to;
  }
  void load();
}

async function toggleShop(shop: string): Promise<void> {
  if (openShop.value === shop) {
    openShop.value = '';
    shopDetail.value = [];
    return;
  }
  openShop.value = shop;
  try {
    shopDetail.value = await shopAllocationDetail({ shop, ...windowOf(range.value, customFrom.value, customTo.value) });
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '读取明细失败', 'error');
    shopDetail.value = [];
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const win = windowOf(range.value, customFrom.value, customTo.value);
    // 四个数**一次取全**：对账（按厂家）/ 付款（列表与聚合同窗口）/ 供应商（弹层下拉）/ 店铺分摊。
    // 分开取会让"对账表说已付 100、付款列表却只有 80"这种缝有机会出现（两处各自过了不同的窗口）。
    const [rc, pm, sp] = await Promise.all([
      reconciliation(win),
      listPayments(win),
      listSuppliers(),
    ]);
    recon.value = rc;
    payments.value = pm;
    suppliers.value = sp;
    if (view.value === 'shop') {
      shopRows.value = await shopAllocation(win);
      // 换窗口后原展开的店铺明细要重取（否则明细表还挂着上一个窗口的数）
      if (openShop.value) {
        shopDetail.value = await shopAllocationDetail({ shop: openShop.value, ...win });
      }
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '读取对账数据失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
// 保活的代价要还回去：容器 `token` 变了（拿货单/付款在别处变了）就重取
watch(
  () => token.value,
  () => void load()
);
// 切到「按店铺」才去取分摊（多数时候看的是厂家账；没必要每次都多跑一趟）
watch(view, (v) => {
  if (v === 'shop') void load();
});
</script>

<style scoped>
/* 面板区自己滚（外层 `.td-panels` 是 overflow:hidden），所以这里不要 flex:1 */
.rc-view {
  gap: 12px;
}
.rc-stats {
  flex-shrink: 0;
}
.rc-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.rc-grow {
  flex: 1;
}
/* 面板头右侧动作区（`.wb-panel__head` 是 flex，无"推右"工具类） */
.rc-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  font-weight: 400;
}
/* 欠款（红，本项目约定"涨/欠 = 红"）与已结清（绿）—— 只在这两处用语义色 */
.rc-debt {
  color: var(--wb-danger);
}
.rc-clear {
  color: var(--wb-success);
}
.rc-shop-col {
  min-width: 160px;
}
/* 展开的明细整格铺满：底色区分"这是子表"，并让内层表能自己横滚 */
.rc-detail-cell {
  background: var(--wb-surface-2);
  padding: 0;
}
.rc-detail {
  background: transparent;
}
.rc-field {
  margin-bottom: 10px;
}
.rc-field:last-child {
  margin-bottom: 0;
}
</style>
