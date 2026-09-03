<script setup lang="ts">
// 记付款 / 记退款弹窗：金额以「元」输入，支持 + - * / 算式（如 1000+500），落库转分
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { useStockInStore, centsToYuan } from '../store';

/** 安全解析金额算式（仅支持数字与 + - * / 及括号，禁止 eval），非法或结果非正返回 null */
function parseMoneyExpr(input: string): number | null {
  const src = input.replace(/\s+/g, '');
  if (!src) return null;
  let i = 0;
  const num = (): number => {
    const s = i;
    if (src[i] === '+' || src[i] === '-') i++;
    const ds = i;
    while (i < src.length && /[0-9.]/.test(src[i])) i++;
    if (i === ds) throw new Error('bad');
    const v = Number(src.slice(s, i));
    if (!Number.isFinite(v)) throw new Error('bad');
    return v;
  };
  const factor = (): number => {
    if (src[i] === '(') {
      i++;
      const v = add();
      if (src[i] !== ')') throw new Error('bad');
      i++;
      return v;
    }
    return num();
  };
  const mul = (): number => {
    let v = factor();
    while (i < src.length) {
      if (src[i] === '*') { i++; v *= factor(); }
      else if (src[i] === '/') {
        i++;
        const d = factor();
        if (d === 0) throw new Error('div0');
        v /= d;
      } else break;
    }
    return v;
  };
  const add = (): number => {
    let v = mul();
    while (i < src.length) {
      if (src[i] === '+') { i++; v += mul(); }
      else if (src[i] === '-') { i++; v -= mul(); }
      else break;
    }
    return v;
  };
  try {
    const v = add();
    if (i !== src.length) return null;
    if (!Number.isFinite(v) || v <= 0) return null;
    return Math.round(v * 100) / 100; // 四舍五入到分
  } catch {
    return null;
  }
}

const store = useStockInStore();

const emit = defineEmits<{ (e: 'close'): void }>();

const amountInput = ref<HTMLInputElement | null>(null);
const type = ref<'payment' | 'refund'>('payment');
const yuan = ref<string>('');
const payDate = ref<string>('');
const method = ref<string>('');
const note = ref<string>('');
const busy = ref(false);

const supplier = () => store.suppliers.find((s) => s.id === store.paySupplierId);

watch(
  () => store.paymentModalOpen,
  (open) => {
    if (open) {
      type.value = store.payDefaultType;
      yuan.value = '';
      method.value = '';
      note.value = '';
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      payDate.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
  },
  { immediate: true },
);

// 打开弹窗自动聚焦金额输入
onMounted(() => {
  nextTick(() => amountInput.value?.focus());
});

/** 金额（元）：算式求值结果；空/非法/非正为 null */
const amountValue = computed<number | null>(() => parseMoneyExpr(yuan.value));

async function save() {
  const amount = amountValue.value;
  if (amount === null) return;
  busy.value = true;
  try {
    const ok = await store.addPayment({
      supplierId: store.paySupplierId,
      payDate: payDate.value,
      type: type.value,
      yuan: amount,
      method: method.value,
      note: note.value,
    });
    if (ok) emit('close');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--wb-overlay)]" @click.self="emit('close')">
    <div class="w-[420px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] shadow-xl">
      <div class="flex items-center justify-between border-b border-[var(--wb-border)] px-4 py-3">
        <h3 class="text-sm font-semibold">{{ type === 'refund' ? '记退款' : '记付款' }} · {{ supplier()?.name }}</h3>
        <button class="text-[var(--wb-text-muted)] hover:text-[var(--wb-text)]" @click="emit('close')">✕</button>
      </div>
      <div class="space-y-3 px-4 py-4">
        <div class="flex gap-1">
          <button
            class="rounded-lg px-3 py-1.5 text-xs"
            :class="type === 'payment' ? 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)]' : 'border border-[var(--wb-border)] hover:bg-[var(--wb-hover)]'"
            @click="type = 'payment'"
          >
            付款
          </button>
          <button
            class="rounded-lg px-3 py-1.5 text-xs"
            :class="type === 'refund' ? 'bg-[var(--wb-danger)] text-[var(--wb-primary-contrast)]' : 'border border-[var(--wb-border)] hover:bg-[var(--wb-hover)]'"
            @click="type = 'refund'"
          >
            退款
          </button>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="mb-1 block text-xs text-[var(--wb-text-muted)]">金额（元）</label>
            <input
              v-model="yuan"
              type="text"
              inputmode="decimal"
              placeholder="支持 + - * /，如 1000+500"
              class="wb-input"
              ref="amountInput"
              @keyup.enter="save"
            />
            <p v-if="yuan.trim() && amountValue === null" class="mt-1 text-[10px] text-[var(--wb-danger)]">
              算式有误或金额需大于 0
            </p>
            <p v-else-if="amountValue !== null" class="mt-1 text-[10px] text-[var(--wb-success)]">
              = ¥{{ amountValue.toFixed(2) }}
            </p>
          </div>
          <div>
            <label class="mb-1 block text-xs text-[var(--wb-text-muted)]">日期</label>
            <input v-model="payDate" type="date" class="wb-input" />
          </div>
        </div>
        <div>
          <label class="mb-1 block text-xs text-[var(--wb-text-muted)]">方式</label>
          <select v-model="method" class="wb-input">
            <option value="">现金</option>
            <option value="微信">微信</option>
            <option value="支付宝">支付宝</option>
            <option value="转账">转账</option>
          </select>
        </div>
        <div>
          <label class="mb-1 block text-xs text-[var(--wb-text-muted)]">备注</label>
          <input v-model="note" type="text" placeholder="选填" class="wb-input" @keyup.enter="save" />
        </div>
      </div>
      <div class="flex justify-end gap-2 border-t border-[var(--wb-border)] px-4 py-3">
        <button class="rounded-lg border border-[var(--wb-border)] px-3 py-1.5 text-xs hover:bg-[var(--wb-hover)]" @click="emit('close')">取消</button>
        <button
          class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
          :class="type === 'refund' ? 'bg-[var(--wb-danger)] text-[var(--wb-primary-contrast)] hover:opacity-90' : 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)] hover:bg-[var(--wb-primary-hover)]'"
          :disabled="busy || amountValue === null"
          @click="save"
        >
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>
