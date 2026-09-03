<script setup lang="ts">
// 「对账」Tab：厂商维度（拿货/已付/欠款）+ 店铺维度（拿货成本按来源订单分摊）。
// 时间筛选（全部/本月）作用于两个维度。
import { ref, watch, computed } from 'vue';
import { useStockInStore, centsToYuan } from '../store';
import type { Payment, PurchaseOrder, ShopAllocationDetailRow } from '@/types';

const props = defineProps<{
  onOpenSupplier: (target?: { id: number; name: string; phone: string; note: string } | null) => void;
  onOpenPayment: (supplierId: number, type: 'payment' | 'refund') => void;
}>();

const store = useStockInStore();

// 视图切换：厂商（欠款对账）/ 店铺（拿货成本归属）
const view = ref<'supplier' | 'shop'>('supplier');

// 时间窗口变化（含自定义起止日期）→ 按当前视图刷新
watch(
  () => [store.reconRange, store.reconCustomFrom, store.reconCustomTo],
  () => {
    if (view.value === 'supplier') store.refreshAll();
    else store.loadShopAllocation();
  },
);
watch(
  view,
  (v) => {
    if (v === 'shop') store.loadShopAllocation();
  },
);

// ---- 厂商维度 ----
const expandedId = ref<number>(0);
const totals = computed(() =>
  store.selectedRecon.reduce(
    (acc, r) => {
      acc.purchase += r.purchaseCents;
      acc.paid += r.paidCents;
      acc.refund += r.refundCents;
      acc.balance += r.balanceCents;
      return acc;
    },
    { purchase: 0, paid: 0, refund: 0, balance: 0 },
  ),
);

function ordersOf(supplierId: number): PurchaseOrder[] {
  return store.orders
    .filter((o) => o.supplierId === supplierId && o.status === 'submitted')
    .filter((o) => !store.reconFrom || o.bizDate >= store.reconFrom)
    .filter((o) => !store.reconTo || o.bizDate <= store.reconTo);
}

function paymentsOf(supplierId: number): Payment[] {
  return store.payments.filter(
    (p) => p.supplierId === supplierId && (!store.reconFrom || p.payDate >= store.reconFrom) && (!store.reconTo || p.payDate <= store.reconTo),
  );
}

/** 差额状态文案：欠款 / 多付 / 已结清 */
function balanceText(b: number): string {
  if (b > 0) return '欠款 ¥' + centsToYuan(b);
  if (b < 0) return '多付 ¥' + centsToYuan(-b);
  return '已结清 ¥0.00';
}

// 时间范围下拉选项（顶部紧凑化：预设 全部/今天/本月/本年 + 自定义起止）
const RANGE_OPTIONS = [
  { k: 'all', t: '全部' },
  { k: 'day', t: '今天' },
  { k: 'month', t: '本月' },
  { k: 'year', t: '本年' },
  { k: 'custom', t: '自定义' },
] as const;

/** 进入自定义区间：首次默认当月窗口，可再改起止 */
function enableCustomRange() {
  if (store.reconRange !== 'custom') {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    store.reconCustomFrom = `${y}-${p(m)}-01`;
    store.reconCustomTo = `${y}-${p(m)}-${p(new Date(y, m, 0).getDate())}`;
  }
  store.reconRange = 'custom';
}

/** 下拉选择时间范围：选中「自定义」时预填当月窗口，其余直接切换 */
function onRangeChange(e: Event) {
  const k = (e.target as HTMLSelectElement).value;
  if (k === 'custom') enableCustomRange();
  else store.reconRange = k as typeof store.reconRange;
}

function openSupplierEdit(s: { id: number; name: string; phone: string; note: string }) {
  props.onOpenSupplier({ id: s.id, name: s.name, phone: s.phone, note: s.note });
}

// ---- 店铺维度 ----
const expandedShop = ref<string>('');
const shopDetail = ref<ShopAllocationDetailRow[]>([]);
const shopDetailLoading = ref(false);

const shopTotals = computed(() =>
  store.shopAlloc.reduce(
    (acc, r) => {
      acc.qty += r.qty;
      acc.amount += r.amountCents;
      acc.orders += r.orderCount;
      return acc;
    },
    { qty: 0, amount: 0, orders: 0 },
  ),
);

async function toggleShop(shop: string) {
  if (expandedShop.value === shop) {
    expandedShop.value = '';
    shopDetail.value = [];
    return;
  }
  expandedShop.value = shop;
  shopDetail.value = [];
  shopDetailLoading.value = true;
  try {
    shopDetail.value = await store.fetchShopDetail(shop);
  } finally {
    shopDetailLoading.value = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col gap-3 overflow-y-auto pr-0.5">
    <!-- 顶部：视图切换 + 时间筛选 + 合计 -->
    <section class="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] px-3 py-2">
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex gap-1">
          <button
            class="rounded-lg px-2.5 py-1 text-xs"
            :class="view === 'supplier' ? 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)]' : 'border border-[var(--wb-border)] hover:bg-[var(--wb-hover)]'"
            @click="view = 'supplier'"
          >
            厂商
          </button>
          <button
            class="rounded-lg px-2.5 py-1 text-xs"
            title="拿货成本按拿货单锁定的来源订单拆分到店铺"
            :class="view === 'shop' ? 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)]' : 'border border-[var(--wb-border)] hover:bg-[var(--wb-hover)]'"
            @click="view = 'shop'"
          >
            店铺
          </button>
        </div>
        <!-- 时间范围下拉（全部/今天/本月/本年/自定义），自定义时并排日期区间 -->
        <select
          class="rounded-lg border border-[var(--wb-border)] bg-[var(--wb-surface-2)] px-2 py-1 text-xs text-[var(--wb-text)] outline-none transition-colors hover:bg-[var(--wb-hover)]"
          title="时间范围：全部 / 今天 / 本月 / 本年 / 自定义"
          :value="store.reconRange"
          @change="onRangeChange"
        >
          <option v-for="o in RANGE_OPTIONS" :key="o.k" :value="o.k">{{ o.t }}</option>
        </select>
        <template v-if="store.reconRange === 'custom'">
          <input v-model="store.reconCustomFrom" type="date" class="wb-input !w-[134px] !px-1.5 !py-0.5 text-xs" />
          <span class="text-xs text-[var(--wb-text-muted)]">~</span>
          <input v-model="store.reconCustomTo" type="date" class="wb-input !w-[134px] !px-1.5 !py-0.5 text-xs" />
        </template>
      </div>

      <!-- 厂商合计 -->
      <div v-if="view === 'supplier'" class="flex items-center gap-4 text-xs">
        <span class="text-[var(--wb-text-muted)]">拿货 <b class="text-[var(--wb-text)]">¥{{ centsToYuan(totals.purchase) }}</b></span>
        <span class="text-[var(--wb-text-muted)]">已付 <b class="text-[var(--wb-text)]">¥{{ centsToYuan(totals.paid) }}</b></span>
        <span class="text-[var(--wb-text-muted)]">
          欠款
          <b class="text-sm" :class="totals.balance > 0 ? 'text-[var(--wb-danger)]' : 'text-[var(--wb-success)]'">¥{{ centsToYuan(totals.balance) }}</b>
        </span>
      </div>
      <!-- 店铺合计 -->
      <div v-else class="flex items-center gap-4 text-xs">
        <span class="text-[var(--wb-text-muted)]">
          店铺成本
          <b class="text-[var(--wb-text)]">¥{{ centsToYuan(shopTotals.amount) }}</b>
        </span>
        <span class="text-[var(--wb-text-muted)]">件数 <b class="text-[var(--wb-text)]">{{ shopTotals.qty }}</b></span>
        <span class="text-[var(--wb-text-muted)]">拿货单 <b class="text-[var(--wb-text)]">{{ shopTotals.orders }}</b></span>
      </div>
    </section>

    <!-- ============ 厂商视图 ============ -->
    <template v-if="view === 'supplier'">
      <div v-if="store.selectedRecon.length === 0" class="flex-1 py-16 text-center text-xs text-[var(--wb-text-muted)]">
        还没有厂商，点上方「+ 新增厂商」开始记录拿货与付款
      </div>
      <section v-for="r in store.selectedRecon" :key="r.supplierId" class="shrink-0 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)]">
        <!-- 卡片头 -->
        <div class="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-[var(--wb-hover)]" @click="expandedId = expandedId === r.supplierId ? 0 : r.supplierId">
          <span class="text-xs font-semibold">{{ r.supplierName }}</span>
          <span class="rounded bg-[var(--wb-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--wb-text-muted)]">{{ r.orderCount }} 单</span>
          <span class="ml-auto flex items-center gap-3 text-xs">
            <span class="text-[var(--wb-text-muted)]">拿货 <b class="text-[var(--wb-text)]">¥{{ centsToYuan(r.purchaseCents) }}</b></span>
            <span class="text-[var(--wb-text-muted)]">已付 <b class="text-[var(--wb-text)]">¥{{ centsToYuan(r.paidCents) }}</b></span>
            <span class="text-[var(--wb-text-muted)]">
              {{ r.refundCents ? '退款 ¥' + centsToYuan(r.refundCents) : '' }}
              <b :class="r.balanceCents > 0 ? 'text-[var(--wb-danger)]' : 'text-[var(--wb-success)]'">¥{{ centsToYuan(r.balanceCents) }}</b>
            </span>
          </span>
          <span class="flex shrink-0 gap-1" @click.stop>
            <button
              class="rounded-lg bg-[var(--wb-primary)] px-2 py-1 text-[10px] text-[var(--wb-primary-contrast)] hover:bg-[var(--wb-primary-hover)]"
              @click="props.onOpenPayment(r.supplierId, 'payment')"
            >
              记付款
            </button>
            <button class="rounded-lg border border-[var(--wb-border)] px-2 py-1 text-[10px] hover:bg-[var(--wb-hover)]" @click="props.onOpenPayment(r.supplierId, 'refund')">
              记退款
            </button>
            <button
              class="rounded-lg border border-[var(--wb-border)] px-2 py-1 text-[10px] hover:bg-[var(--wb-hover)]"
              @click="openSupplierEdit(store.suppliers.find((s) => s.id === r.supplierId) ?? { id: r.supplierId, name: r.supplierName, phone: '', note: '' })"
            >
              编辑
            </button>
          </span>
        </div>

        <!-- 展开流水 -->
        <div v-if="expandedId === r.supplierId" class="border-t border-[var(--wb-border)] px-3 py-2">
          <!-- 差额核对：欠款 = 拿货合计 − 已付合计 + 退款（与卡片头同一聚合，便于核对差额来源） -->
          <div class="mb-2 rounded-lg border border-[var(--wb-border)] bg-[var(--wb-surface-2)] px-2.5 py-2 text-xs">
            <div class="mb-1 flex items-center justify-between text-[10px] font-medium text-[var(--wb-text-muted)]">
              <span>差额核对</span>
              <span>筛选：{{ store.reconLabel }}</span>
            </div>
            <div class="flex items-center gap-2 py-0.5">
              <span class="text-[var(--wb-text-muted)]">拿货合计</span>
              <span class="rounded bg-[var(--wb-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--wb-text-muted)]">{{ ordersOf(r.supplierId).length }} 单</span>
              <span class="ml-auto font-medium tabular-nums">+¥{{ centsToYuan(r.purchaseCents) }}</span>
            </div>
            <div class="flex items-center gap-2 py-0.5">
              <span class="text-[var(--wb-text-muted)]">已付合计</span>
              <span class="rounded bg-[var(--wb-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--wb-text-muted)]">{{ paymentsOf(r.supplierId).filter((p) => p.type === 'payment').length }} 笔</span>
              <span class="ml-auto font-medium tabular-nums">−¥{{ centsToYuan(r.paidCents) }}</span>
            </div>
            <div v-if="r.refundCents > 0" class="flex items-center gap-2 py-0.5">
              <span class="text-[var(--wb-text-muted)]">退款冲抵</span>
              <span class="rounded bg-[var(--wb-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--wb-text-muted)]">{{ paymentsOf(r.supplierId).filter((p) => p.type === 'refund').length }} 笔</span>
              <span class="ml-auto font-medium tabular-nums text-[var(--wb-danger)]">+¥{{ centsToYuan(r.refundCents) }}</span>
            </div>
            <div class="mt-1 flex items-center justify-between border-t border-[var(--wb-border)] pt-1.5">
              <span class="text-xs font-medium">差额</span>
              <span class="text-sm font-bold tabular-nums" :class="r.balanceCents > 0 ? 'text-[var(--wb-danger)]' : r.balanceCents < 0 ? 'text-[var(--wb-success)]' : 'text-[var(--wb-text)]'">
                {{ balanceText(r.balanceCents) }}
              </span>
            </div>
            <div v-if="r.balanceCents > 0" class="mt-1.5 text-[10px] leading-relaxed text-[var(--wb-text-muted)]">
              仍有欠款：请对照下方「拿货记录」逐单核对金额，再对照「付款记录」确认是否有漏记/记少的付款。
              <template v-if="store.reconRange !== 'all'">当前窗口「{{ store.reconLabel }}」只统计区间内的拿货与付款；更早/更晚的账不计入，可切「全部」核对完整账目。</template>
            </div>
            <div v-else-if="r.balanceCents < 0" class="mt-1.5 text-[10px] leading-relaxed text-[var(--wb-text-muted)]">
              多付部分可点「记退款」冲抵，将计入下次差额。
            </div>
          </div>
          <div class="mb-1 text-[10px] font-medium text-[var(--wb-text-muted)]">拿货记录</div>
          <div v-if="ordersOf(r.supplierId).length === 0" class="py-1 text-xs text-[var(--wb-text-muted)]">无</div>
          <div v-for="o in ordersOf(r.supplierId)" :key="'o' + o.id" class="flex items-center gap-2 py-0.5 text-xs">
            <span class="w-[76px] text-[var(--wb-text-muted)]">{{ o.bizDate }}</span>
            <span class="truncate">{{ o.mode === 'package' ? '（包价）' : (o.items.length + ' 行明细') }}</span>
            <span class="ml-auto font-medium">¥{{ centsToYuan(o.totalCents) }}</span>
            <button class="rounded px-1 text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)]" title="删除拿货单" @click="store.deleteOrder(o)">✕</button>
          </div>
          <div class="mb-1 mt-2 text-[10px] font-medium text-[var(--wb-text-muted)]">付款记录</div>
          <div v-if="paymentsOf(r.supplierId).length === 0" class="py-1 text-xs text-[var(--wb-text-muted)]">无</div>
          <div v-for="p in paymentsOf(r.supplierId)" :key="'p' + p.id" class="flex items-center gap-2 py-0.5 text-xs">
            <span class="w-[76px] text-[var(--wb-text-muted)]">{{ p.payDate }}</span>
            <span class="rounded px-1.5 py-0.5 text-[10px]" :class="p.type === 'refund' ? 'bg-[var(--wb-danger)]/10 text-[var(--wb-danger)]' : 'bg-[var(--wb-success)]/10 text-[var(--wb-success)]'">
              {{ p.type === 'refund' ? '退款' : '付款' }}
            </span>
            <span class="text-[var(--wb-text-muted)]">{{ p.method }}</span>
            <span class="truncate text-[var(--wb-text-muted)]">{{ p.note }}</span>
            <span class="ml-auto font-medium" :class="p.type === 'refund' ? 'text-[var(--wb-danger)]' : ''">¥{{ centsToYuan(p.amountCents) }}</span>
            <button class="rounded px-1 text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)]" title="删除记录" @click="store.deletePayment(p)">✕</button>
          </div>
        </div>
      </section>
    </template>

    <!-- ============ 店铺视图 ============ -->
    <template v-else>
      <div v-if="store.shopAllocLoading" class="flex-1 py-16 text-center text-xs text-[var(--wb-text-muted)]">加载中…</div>
      <div v-else-if="store.shopAlloc.length === 0" class="flex-1 py-16 text-center text-xs text-[var(--wb-text-muted)]">
        还没有可归属店铺的拿货成本。<br />
        从「数据统计」按订单筛选后点「生成拿货单」，拿货成本会自动按店铺拆分到这里。
      </div>
      <section v-for="row in store.shopAlloc" :key="row.shop" class="shrink-0 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)]">
        <div class="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-[var(--wb-hover)]" @click="toggleShop(row.shop)">
          <span class="text-xs font-semibold">{{ row.shop }}</span>
          <span class="rounded bg-[var(--wb-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--wb-text-muted)]">{{ row.orderCount }} 单</span>
          <span class="ml-auto flex items-center gap-3 text-xs">
            <span class="text-[var(--wb-text-muted)]">件数 <b class="text-[var(--wb-text)]">{{ row.qty }}</b></span>
            <span class="text-[var(--wb-text-muted)]">成本 <b class="text-[var(--wb-text)]">¥{{ centsToYuan(row.amountCents) }}</b></span>
          </span>
          <span class="shrink-0 text-[var(--wb-text-muted)]">{{ expandedShop === row.shop ? '▾' : '▸' }}</span>
        </div>
        <div v-if="expandedShop === row.shop" class="border-t border-[var(--wb-border)] px-3 py-2">
          <div v-if="shopDetailLoading" class="py-2 text-xs text-[var(--wb-text-muted)]">加载中…</div>
          <div v-else-if="shopDetail.length === 0" class="py-1 text-xs text-[var(--wb-text-muted)]">无明细</div>
          <div v-else class="space-y-0.5 text-xs">
            <div class="flex items-center gap-2 border-b border-[var(--wb-border)] pb-1 text-[10px] text-[var(--wb-text-muted)]">
              <span class="w-[76px] shrink-0">日期</span>
              <span class="w-14 shrink-0">厂商</span>
              <span class="w-16 shrink-0">款编码</span>
              <span class="min-w-0 flex-1 truncate">款式名</span>
              <span class="w-10 shrink-0">款色</span>
              <span class="w-8 shrink-0">码</span>
              <span class="w-8 shrink-0 text-right">件</span>
              <span class="w-14 shrink-0 text-right">单价</span>
              <span class="w-20 shrink-0 text-right">金额</span>
            </div>
            <div v-for="(l, i) in shopDetail" :key="i" class="flex items-center gap-2 py-0.5">
              <span class="w-[76px] shrink-0 text-[var(--wb-text-muted)]">{{ l.bizDate }}</span>
              <span class="w-14 shrink-0 truncate text-[var(--wb-text-muted)]" :title="l.supplierName">{{ l.supplierName }}</span>
              <span class="w-16 shrink-0 font-medium">{{ l.styleCode }}</span>
              <span class="min-w-0 flex-1 truncate" :title="l.styleName">{{ l.styleName }}</span>
              <span class="w-10 shrink-0">{{ l.color }}</span>
              <span class="w-8 shrink-0">{{ l.size || '—' }}</span>
              <span class="w-8 shrink-0 text-right tabular-nums">{{ l.qty }}</span>
              <span class="w-14 shrink-0 text-right tabular-nums text-[var(--wb-text-muted)]">{{ (l.priceCents / 100).toFixed(2) }}</span>
              <span class="w-20 shrink-0 text-right font-medium tabular-nums">¥{{ centsToYuan(l.amountCents) }}</span>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
