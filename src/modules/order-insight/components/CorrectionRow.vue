<template>
  <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4 shadow-sm">
    <div class="flex items-start gap-3">
      <OrderThumb :path="order.localPath" size="md" />
      <div class="flex-1 min-w-0">
        <!-- 订单信息 -->
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium text-[var(--wb-text)] truncate">{{ order.orderNo }}</span>
          <span
            v-if="order.styleCode"
            class="shrink-0 px-1.5 py-0.5 rounded bg-[var(--wb-primary-soft)] text-[var(--wb-primary)] text-xs font-medium"
          >
            {{ order.styleCode }}
          </span>
          <span v-else class="shrink-0 px-1.5 py-0.5 rounded bg-[var(--wb-warning)] text-white text-xs font-medium">
            未归类
          </span>
          <span class="ml-auto shrink-0 text-xs text-[var(--wb-text-muted)]">
            {{ order.shop }}<template v-if="order.size"> · {{ order.size }}</template
            ><template v-if="order.orderTime"> · {{ order.orderTime }}</template>
          </span>
        </div>
        <!-- 可编辑字段 -->
        <div class="mt-3 grid grid-cols-2 md:grid-cols-3 gap-2">
          <label class="block">
            <span class="text-xs text-[var(--wb-text-muted)]">款式</span>
            <input v-model="draft.category" class="mt-1 h-8 w-full rounded-lg border border-[var(--wb-border)] bg-transparent px-2.5 text-sm text-[var(--wb-text)] outline-none focus:border-[var(--wb-primary)]" />
          </label>
          <label class="block">
            <span class="text-xs text-[var(--wb-text-muted)]">颜色</span>
            <input v-model="draft.color" class="mt-1 h-8 w-full rounded-lg border border-[var(--wb-border)] bg-transparent px-2.5 text-sm text-[var(--wb-text)] outline-none focus:border-[var(--wb-primary)]" />
          </label>
          <label class="block">
            <span class="text-xs text-[var(--wb-text-muted)]">logo</span>
            <input v-model="draft.logo" class="mt-1 h-8 w-full rounded-lg border border-[var(--wb-border)] bg-transparent px-2.5 text-sm text-[var(--wb-text)] outline-none focus:border-[var(--wb-primary)]" />
          </label>
          <label class="block">
            <span class="text-xs text-[var(--wb-text-muted)]">款式名称</span>
            <input
              v-model="draft.styleName"
              class="mt-1 h-8 w-full rounded-lg border border-[var(--wb-border)] bg-transparent px-2.5 text-sm text-[var(--wb-text)] outline-none focus:border-[var(--wb-primary)]"
              placeholder="识别组合名，可修改"
            />
          </label>
          <label class="block">
            <span class="text-xs text-[var(--wb-text-muted)]">款编码</span>
            <select
              v-model.number="draft.targetStyleId"
              class="mt-1 h-8 w-full rounded-lg border border-[var(--wb-border)] bg-transparent px-2 text-sm text-[var(--wb-text)] outline-none focus:border-[var(--wb-primary)]"
              @change="onStyleSelected"
            >
              <option :value="0">
                自动匹配{{ order.styleCode ? `（当前 ${order.styleCode}）` : '（未归类）' }}
              </option>
              <option v-for="s in store.styles" :key="s.id" :value="s.id">
                {{ s.code }}{{ s.name ? ' · ' + s.name : '' }}
              </option>
            </select>
            <p class="mt-0.5 text-[10px] leading-tight text-[var(--wb-text-muted)]">
              选择其他款编码可把此单归并为同一款
            </p>
          </label>
        </div>
      </div>
      <!-- 操作 -->
      <div class="shrink-0 flex flex-col items-end gap-2">
        <button
          class="h-8 px-3 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          :class="dirty ? 'bg-[var(--wb-primary)] text-[var(--wb-primary-contrast)]' : 'border border-[var(--wb-border)] text-[var(--wb-text)] hover:border-[var(--wb-primary)] hover:text-[var(--wb-primary)]'"
          :disabled="saving"
          :title="dirty ? '' : '识别结果无需修改时点击，直接标记为已核对'"
          @click="dirty ? save() : confirmCorrect()"
        >
          {{ saving ? '处理中…' : dirty ? '保存并归类' : '确认无误' }}
        </button>
        <span v-if="reassigned" class="text-xs text-[var(--wb-success)]">{{ reassigned }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { OrderRecord } from '@/types';
import { buildStyleFingerprint } from '@/lib/styleMatcher';
import { toast } from '@/core/services/toast';
import { useOrderInsightStore } from '../store';
import OrderThumb from './OrderThumb.vue';

const props = defineProps<{ order: OrderRecord }>();
const emit = defineEmits<{ (e: 'saved', id: number): void }>();

const store = useOrderInsightStore();

interface Draft {
  category: string;
  color: string;
  logo: string;
  /** 款式名称：识别后由 category+styleName 组合，用户可修正（同步到款编码展示名） */
  styleName: string;
  /** 手动归并目标款编码 id；0=自动匹配/保持当前归属 */
  targetStyleId: number;
}

/** 当前订单归属款编码对应的款 id（无归属为 0） */
const currentStyleId = computed(
  () => store.styles.find((s) => s.code === props.order.styleCode)?.id ?? 0,
);

const draft = ref<Draft>({
  category: props.order.category ?? '',
  color: props.order.color ?? '',
  logo: props.order.logo ?? '',
  styleName: props.order.styleName || props.order.category || '',
  targetStyleId: currentStyleId.value,
});
const saving = ref(false);
const reassigned = ref('');

/** 选择款编码后：款式名称同步为该款的展示名（保持一致；款无名称时留空待填，保存后会写入款展示名） */
function onStyleSelected() {
  const style = store.styles.find((s) => s.id === draft.value.targetStyleId);
  if (style) draft.value.styleName = style.name ?? '';
}

const dirty = computed(() => {
  const o = props.order;
  return (
    draft.value.category !== (o.category ?? '') ||
    draft.value.color !== (o.color ?? '') ||
    draft.value.logo !== (o.logo ?? '') ||
    draft.value.styleName !== (o.styleName || o.category || '') ||
    draft.value.targetStyleId !== currentStyleId.value
  );
});

/**
 * 保存：字段有修改才提交。
 * - 款式/颜色变化且未手动选款编码 → reclassify=true 按新指纹自动归类；
 * - 手动选了其他款编码 → 归并到该款（并把指纹记入该款，后续自动识别命中同一款编码）；
 * - 款式名称变化 → 同步到款编码展示名。
 */
/** 确认无误：识别结果无需修改时直接标记已核对（corrected=1），不提交任何字段 */
async function confirmCorrect() {
  const id = props.order.id;
  if (id === undefined || saving.value) return;
  saving.value = true;
  try {
    const updated = await store.markOrdersCorrected([id]);
    if (updated) toast('已确认无误', 'success');
    else toast('订单不存在或已核对', 'info');
  } catch (e: unknown) {
    toast(`标记失败: ${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    saving.value = false;
  }
}

async function save() {
  const id = props.order.id;
  if (id === undefined) {
    toast('订单缺少 id，无法保存', 'error');
    return;
  }
  if (!dirty.value) {
    toast('没有修改', 'info');
    return;
  }
  saving.value = true;
  reassigned.value = '';
  try {
    const o = props.order;
    const features = o.features ?? [];
    const targetStyleId = draft.value.targetStyleId || 0;
    const reclassify =
      targetStyleId === 0 &&
      (draft.value.category !== (o.category ?? '') || draft.value.color !== (o.color ?? ''));
    const fingerprint =
      reclassify || targetStyleId ? buildStyleFingerprint(draft.value.category, features) : undefined;
    const styleNameChanged = draft.value.styleName !== (o.styleName || o.category || '');
    const res = await store.updateOrderFields({
      id,
      category: draft.value.category,
      color: draft.value.color,
      logo: draft.value.logo,
      fingerprint,
      features,
      reclassify,
      styleName: styleNameChanged ? draft.value.styleName : undefined,
      targetStyleId: targetStyleId || undefined,
    });
    if (res.ok) {
      // 保存后归属信息直接取主进程返回（orders 全量镜像不再逐行实时同步）
      if (targetStyleId) {
        reassigned.value = res.styleCode
          ? `已归并为 ${res.styleCode}${res.styleColorCode ? ' / ' + res.styleColorCode : ''}`
          : '已归并';
      } else if (reclassify) {
        reassigned.value = res.styleCode
          ? `已归类 ${res.styleCode}${res.styleColorCode ? ' / ' + res.styleColorCode : ''}`
          : '已重新归类';
      }
      emit('saved', id);
    }
  } catch (e: unknown) {
    toast(`保存失败: ${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    saving.value = false;
  }
}
</script>
