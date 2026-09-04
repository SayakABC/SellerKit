<template>
  <div class="space-y-3">
    <!-- 统计与搜索 -->
    <div
      class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] px-4 py-3 shadow-sm flex items-center gap-4"
    >
      <span class="text-sm text-[var(--wb-text)]">
        款编码 <b class="font-medium text-[var(--wb-primary)]">{{ store.styles.length }}</b>
      </span>
      <span class="text-sm text-[var(--wb-text)]">
        款色 <b class="font-medium text-[var(--wb-primary)]">{{ colorCount }}</b>
      </span>
      <span class="text-sm text-[var(--wb-text)]">
        图片 <b class="font-medium text-[var(--wb-primary)]">{{ imageCount }}</b>
      </span>
      <button
        class="h-9 shrink-0 rounded-lg border border-[var(--wb-border)] bg-transparent px-3 text-xs font-medium text-[var(--wb-text)] transition-colors hover:bg-[var(--wb-hover)]"
        title="下载产品库导入模板（含填写说明）"
        @click="store.downloadProductTemplate()"
      >
        下载模板
      </button>
      <button
        class="h-9 shrink-0 rounded-lg bg-[var(--wb-primary)] px-3 text-xs font-medium text-[var(--wb-primary-contrast)] transition-colors hover:bg-[var(--wb-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        title="通过 Excel 批量维护产品库（款编码 / 款式名 / 品类 / 特征 / 颜色 / 图片 / 指纹）；填「图片」列会用与订单识别相同的引擎生成指纹，订单导入后可直接命中"
        :disabled="store.importing"
        @click="handleImport"
      >
        {{ store.importing ? '导入中…' : '导入 Excel' }}
      </button>
      <span v-if="store.importing" class="shrink-0 text-xs text-[var(--wb-text-muted)]">{{ store.importTip }}</span>
      <input
        v-model="query"
        class="ml-auto h-9 w-64 rounded-lg border border-[var(--wb-border)] bg-transparent px-3 text-sm text-[var(--wb-text)] outline-none focus:border-[var(--wb-primary)]"
        placeholder="搜索款编码 / 款式名 / 颜色…"
      />
    </div>

    <!-- 导入失败明细弹窗 -->
    <div
      v-if="importErrors.length"
      class="fixed inset-0 z-50 flex items-center justify-center bg-[var(--wb-overlay)]"
      @click.self="importErrors = []"
    >
      <div
        class="w-[480px] max-w-[90vw] overflow-hidden rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] shadow-xl"
      >
        <div class="flex items-center justify-between border-b border-[var(--wb-border)] px-4 py-3">
          <span class="text-sm font-medium text-[var(--wb-text)]">导入失败明细（{{ importErrors.length }} 行）</span>
          <button class="text-sm text-[var(--wb-text-muted)] hover:text-[var(--wb-text)]" @click="importErrors = []">✕</button>
        </div>
        <div class="max-h-[50vh] overflow-auto p-3">
          <div
            v-for="e in importErrors"
            :key="e.row"
            class="flex gap-2 border-b border-[var(--wb-border)] py-1.5 text-xs last:border-0"
          >
            <span class="shrink-0 font-medium text-[var(--wb-danger)]">第 {{ e.row }} 行</span>
            <span class="text-[var(--wb-text)]">{{ e.message }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 款式卡片网格 -->
    <div v-if="filtered.length" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      <div
        v-for="s in filtered"
        :key="s.id"
        class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] shadow-sm overflow-hidden"
      >
        <div class="relative">
        <!-- 卡片主体：点击展开/收起款色 -->
        <div class="cursor-pointer" @click="toggle(s.id)">
          <!-- 封面图：IO 懒加载缩略图（fill 撑满 h-36），不再全量预取 -->
          <div class="relative h-36 bg-[var(--wb-surface-2)]">
            <OrderThumb :path="s.coverPath" fill placeholder="暂无图片" />
            <span
              class="absolute left-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 text-xs font-medium text-white"
            >
              {{ s.code }}
            </span>
            <span
              v-if="s.orderCount > 0"
              class="absolute bottom-2 right-2 rounded-md bg-black/45 px-1.5 py-0.5 text-[11px] text-white"
            >
              {{ s.orderCount }} 单
            </span>
          </div>
          <div class="p-3">
            <div class="flex items-baseline gap-2">
              <span class="text-sm font-medium text-[var(--wb-text)] truncate">{{ s.name || '未命名款式' }}</span>
              <span class="ml-auto shrink-0 text-xs text-[var(--wb-text-muted)]">
                {{ s.colorCount }} 款色 · {{ s.imageCount }} 图
              </span>
            </div>
            <!-- 款色标签 -->
            <div class="mt-2 flex flex-wrap gap-1">
              <span
                v-for="c in s.colors.slice(0, 5)"
                :key="c.id"
                class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-[var(--wb-primary-soft)] text-[var(--wb-primary)] text-xs"
              >
                <i class="h-2 w-2 rounded-full ring-1 ring-[var(--wb-primary)]" :style="{ background: swatch(c.color) }"></i>
                {{ c.color }}
              </span>
              <span v-if="s.colors.length > 5" class="px-1 text-xs text-[var(--wb-text-muted)]">
                +{{ s.colors.length - 5 }}
              </span>
            </div>
          </div>
        </div>
        <!-- 删除款编码（二次确认，避免误删） -->
        <button
          class="absolute right-2 top-2 z-10 rounded-md px-2 py-1 text-xs transition-colors"
          :class="
            confirmDeleteId === s.id
              ? 'bg-[var(--wb-danger)] text-white font-medium'
              : 'bg-black/55 text-white hover:bg-[var(--wb-danger)]'
          "
          :title="confirmDeleteId === s.id ? '再次点击确认删除' : '删除该款编码（订单保留，图片解除归属）'"
          @click.stop="requestDelete(s)"
        >
          {{ confirmDeleteId === s.id ? '确认删除？' : '删除' }}
        </button>
        </div>

        <!-- 展开的款色明细 -->
        <div v-if="activeId === s.id" class="border-t border-[var(--wb-border)] p-3">
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div
              v-for="c in s.colors"
              :key="c.id"
              class="rounded-lg border border-[var(--wb-border)] p-2 flex flex-col items-center gap-1.5"
            >
              <OrderThumb :path="c.imagePath" size="md" />
              <div class="text-xs text-[var(--wb-text)]">{{ c.color }}</div>
              <div class="text-[11px] text-[var(--wb-text-muted)]">{{ c.code }} · {{ c.imageCount }} 图</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <p v-else class="text-center text-sm text-[var(--wb-text-muted)] py-12">
      {{ store.styles.length ? '没有匹配的款式' : '暂无款编码数据，请先在「概览」导入订单并完成识别归类' }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { StyleRecord } from '@/types';
import { useOrderInsightStore } from '../store';
import OrderThumb from './OrderThumb.vue';

const store = useOrderInsightStore();

const query = ref('');
const activeId = ref<number | null>(null);

/** 导入失败明细（row + message），非空时展示弹窗 */
const importErrors = ref<{ row: number; message: string }[]>([]);

async function handleImport() {
  const res = await store.importProductStylesExcel();
  if (res) importErrors.value = res.errors;
}

const styles = computed(() => store.styles);

/** 款色 / 图片总数 */
const colorCount = computed(() => store.styles.reduce((n, s) => n + s.colors.length, 0));
const imageCount = computed(() => store.styles.reduce((n, s) => n + s.imageCount, 0));

/** 搜索过滤（款编码/款式名/款色） */
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return styles.value;
  return styles.value.filter((s) =>
    [s.code, s.name, ...s.colors.map((c) => c.color)]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q)),
  );
});

/** 款色色块（常见颜色名 → 色值，未知返回中性灰） */
const COLOR_SWATCH: Record<string, string> = {
  黑色: '#3a3a3a',
  白色: '#f5f5f5',
  红色: '#d64545',
  蓝色: '#3b6fd4',
  绿色: '#3d9a5c',
  黄色: '#e8c23d',
  橙色: '#e8853d',
  紫色: '#8b5ec9',
  粉色: '#e89ab6',
  灰色: '#9a9a9a',
  棕色: '#8a6a4f',
  米色: '#d9c9a8',
  卡其: '#c3b091',
  藏青: '#2f3b5e',
  军绿: '#5b6b46',
  酒红: '#7d2f3a',
};
function swatch(color: string): string {
  const c = (color || '').toLowerCase();
  for (const [name, value] of Object.entries(COLOR_SWATCH)) {
    if (c.includes(name)) return value;
  }
  return '#b9bdc7';
}

function toggle(id: number) {
  activeId.value = activeId.value === id ? null : id;
}

/** 当前处于「确认删除」态的款式 id（二次点击才真正删除，3s 未确认自动复位） */
const confirmDeleteId = ref<number | null>(null);
let confirmTimer: ReturnType<typeof setTimeout> | undefined;

function requestDelete(s: StyleRecord) {
  if (s.id === undefined) return;
  if (confirmDeleteId.value === s.id) {
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = undefined;
    }
    confirmDeleteId.value = null;
    if (activeId.value === s.id) activeId.value = null;
    store.deleteStyle(s.id);
    return;
  }
  confirmDeleteId.value = s.id;
  if (confirmTimer) clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => {
    confirmDeleteId.value = null;
    confirmTimer = undefined;
  }, 3000);
}
</script>
