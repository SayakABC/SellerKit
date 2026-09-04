<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useOrderInsightStore } from '../store';
import OrderThumb from './OrderThumb.vue';
import {
  DATE_BUCKET_LABEL,
  MEASURE_OP_LABEL,
  STRUCTURED_FIELD_POOL,
  dimensionId,
  fieldLabel,
  getDimensionValue,
  pivotRows,
  rawFieldId,
  type DateBucket,
  type FieldMeta,
  type PivotMeasure,
  type PivotRow,
} from '@/lib/aggregator';
import type { OrderRecord, OrderStatus, PurchaseSourceRow } from '@/types';

const store = useOrderInsightStore();

/** 通知父级进入「拿货对账」Tab 并生成拿货单草稿（rows = 当前筛选订单明细，含店铺/尺码） */
const emit = defineEmits<{ (e: 'open-stock-in', rows: PurchaseSourceRow[]): void }>();

/** 汇总当前筛选订单为来源订单行（保留数据统计中的筛选/归类结果，含店铺与尺码） */
function currentSourceRows(): PurchaseSourceRow[] {
  return store.filteredOrders
    .filter((o) => o.styleCode)
    .map((o) => ({
      shop: o.shop || '',
      styleCode: o.styleCode || '',
      styleName: o.styleName || '',
      color: o.styleColor || '',
      size: o.size || '',
      qty: 1,
    }));
}

/** 「生成拿货单」→ 父级切到 stock-in Tab 并下发新建草稿意图 */
function goStockIn() {
  emit('open-stock-in', currentSourceRows());
}

/** 字段池：结构化字段 + 导入 Excel 的原始列（raw: 前缀） */
const fieldPool = computed<FieldMeta[]>(() => {
  const pool: FieldMeta[] = [...STRUCTURED_FIELD_POOL];
  for (const h of store.headers) {
    if (h) pool.push({ field: rawFieldId(h), label: h });
  }
  return pool;
});

/** 可参与数值度量的字段（与维度池一致，全部可选） */
const metricPool = computed(() => fieldPool.value);

function isDimSelected(field: string): boolean {
  return store.config.pivotDimensions.some((d) => d.field === field);
}
function dimBucketOf(field: string): DateBucket {
  return store.config.pivotDimensions.find((d) => d.field === field)?.bucket ?? 'day';
}
function toggleDim(f: FieldMeta) {
  const arr = store.config.pivotDimensions.slice();
  const i = arr.findIndex((d) => d.field === f.field);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(f.date ? { field: f.field, bucket: 'day' } : { field: f.field });
  store.config = { ...store.config, pivotDimensions: arr };
  store.saveState();
}
function setBucket(field: string, bucket: DateBucket) {
  const arr = store.config.pivotDimensions.map((d) => (d.field === field ? { ...d, bucket } : d));
  store.config = { ...store.config, pivotDimensions: arr };
  store.saveState();
}
function moveDim(i: number, dir: number) {
  const arr = store.config.pivotDimensions.slice();
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  store.config = { ...store.config, pivotDimensions: arr };
  store.saveState();
}

const selectedDims = computed(() => store.config.pivotDimensions);

/** 额外度量（count 固定展示） */
const extraMeasures = computed(() => store.config.pivotMeasures.filter((m) => m.op !== 'count'));

let seq = 0;
function uid(): string {
  seq += 1;
  return 'm' + Date.now().toString(36) + seq;
}
function addMeasure() {
  const pool = metricPool.value;
  if (!pool.length) return;
  const m: PivotMeasure = { id: uid(), field: pool[0].field, op: 'sum' };
  store.config = { ...store.config, pivotMeasures: [...store.config.pivotMeasures, m] };
  store.saveState();
}
function removeMeasure(id: string) {
  store.config = {
    ...store.config,
    pivotMeasures: store.config.pivotMeasures.filter((m) => m.id !== id),
  };
  store.saveState();
}
function setMeasureField(id: string, field: string) {
  store.config = {
    ...store.config,
    pivotMeasures: store.config.pivotMeasures.map((m) => (m.id === id ? { ...m, field } : m)),
  };
  store.saveState();
}
function setMeasureOp(id: string, op: PivotMeasure['op']) {
  store.config = {
    ...store.config,
    pivotMeasures: store.config.pivotMeasures.map((m) => (m.id === id ? { ...m, op } : m)),
  };
  store.saveState();
}

function measureLabel(m: PivotMeasure): string {
  if (m.op === 'count') return '数量';
  return (m.alias || fieldLabel(m.field)) + '(' + MEASURE_OP_LABEL[m.op] + ')';
}

const result = computed(() => store.pivotResult);

/**
 * 维度列合并矩阵：spanMatrix[r][c] > 1 = 该格向下合并的行数；0 = 被上方合并覆盖（跳过渲染）；
 * 1 = 无合并。pivotResult 已按维度键排序，同值必然相邻。
 */
const spanMatrix = computed<number[][]>(() => {
  const rows = result.value;
  const n = rows.length;
  const dims = store.config.pivotDimensions;
  const mat: number[][] = Array.from({ length: n }, () => dims.map(() => 1));
  // 层级合并：列 c 仅在 0..c 列的组合值（前缀）相同时才合并，避免后置列
  // 跨不同上级维度被错误合并（同为 A 合并 → A 中 B 合并 → A 中 B 中 C 合并）
  dims.forEach((_, c) => {
    const prefixOf = (i: number) =>
      dims
        .slice(0, c + 1)
        .map((d) => rows[i].dims[dimensionId(d)] ?? '')
        .join('\u0000');
    let r = 0;
    while (r < n) {
      const prefix = prefixOf(r);
      let e = r + 1;
      while (e < n && prefixOf(e) === prefix) e += 1;
      const span = e - r;
      if (span > 1) {
        mat[r][c] = span;
        for (let k = r + 1; k < e; k += 1) mat[k][c] = 0;
      }
      r = e;
    }
  });
  return mat;
});

const totalRow = computed(() => {
  const [t] = pivotRows(store.filteredOrders, { dimensions: [], measures: store.config.pivotMeasures });
  return t ?? { key: '', dims: {}, measures: {}, count: 0 };
});

function fmt(n: number, op: PivotMeasure['op']): string {
  if (op === 'count' || op === 'countDistinct') return String(Math.round(n));
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

// 钻取：点击维度单元格 → 按该层级（0..depth-1 列）的取值过滤订单明细；
// 点击度量单元格 → 按完整组合（全部维度）过滤。r.dims 在合并起始行即该层级分组值
const drillRows = ref<OrderRecord[]>([]);
const drillTitle = ref('');
function drill(r: PivotRow, depth: number) {
  const dims = store.config.pivotDimensions.slice(0, depth);
  drillRows.value = store.filteredOrders.filter((o) =>
    dims.every((d) => getDimensionValue(o, d) === (r.dims[dimensionId(d)] ?? '')),
  );
  drillTitle.value = dims.map((d) => `${fieldLabel(d.field)} = ${r.dims[dimensionId(d)] || '(空)'}`).join('，');
}

// 旧配置迁移：款式/颜色维度已并入款式名/款色，自动移除已保存的 category/color 分组与度量
const REMOVED_FIELDS = new Set(['category', 'color']);
onMounted(() => {
  const dims = store.config.pivotDimensions.filter((d) => !REMOVED_FIELDS.has(d.field));
  const measures = store.config.pivotMeasures.filter((m) => !REMOVED_FIELDS.has(m.field));
  if (
    dims.length !== store.config.pivotDimensions.length ||
    measures.length !== store.config.pivotMeasures.length
  ) {
    store.config = { ...store.config, pivotDimensions: dims, pivotMeasures: measures };
    store.saveState();
  }
});
</script>

<template>
  <div class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] shadow-sm">
    <div class="flex items-center gap-3 border-b border-[var(--wb-border)] px-4 py-3">
      <span class="text-sm font-medium text-[var(--wb-text)]">数据汇总</span>
      <span class="text-xs text-[var(--wb-text-muted)]"
        >勾选字段即按所选维度分组汇总，支持多选、顺序调整与数值聚合</span
      >
      <div class="ml-auto flex items-center gap-2">
        <span class="text-xs text-[var(--wb-text-muted)]">订单状态</span>
        <select
          class="wb-input !w-auto !py-1 text-xs"
          :value="store.statusFilter"
          @change="store.setStatusFilter(($event.target as HTMLSelectElement).value as OrderStatus | 'all')"
        >
          <option value="all">全部</option>
          <option value="pending">未发货</option>
          <option value="shipped">已发货</option>
        </select>
        <span class="text-xs text-[var(--wb-text-muted)]">{{ store.filteredOrders.length }} / {{ store.orders.length }} 条</span>
        <button
          class="h-8 shrink-0 rounded-lg border border-[var(--wb-primary)] px-3 text-xs font-medium text-[var(--wb-primary)] transition-colors hover:bg-[var(--wb-primary-soft)] disabled:cursor-not-allowed disabled:opacity-45"
          :disabled="!store.filteredOrders.length"
          title="切换到「拿货对账」并按当前订单需求生成拿货单草稿"
          @click="goStockIn"
        >
          生成拿货单
        </button>
        <button
          class="h-8 shrink-0 rounded-lg bg-[var(--wb-primary)] px-3 text-xs font-medium text-[var(--wb-primary-contrast)] transition-colors hover:bg-[var(--wb-primary-hover)] disabled:cursor-not-allowed disabled:opacity-45"
          :disabled="!store.filteredOrders.length"
          title="导出 Excel（归类汇总 / 订单明细 / 数据汇总）"
          @click="store.exportExcel()"
        >
          导出 Excel
        </button>
      </div>
    </div>
    <div class="space-y-4 p-4">
      <!-- 分组维度 -->
      <div>
        <div class="mb-2 text-xs font-medium text-[var(--wb-text-muted)]">分组维度（勾选顺序即维度顺序）</div>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="f in fieldPool"
            :key="f.field"
            class="flex cursor-pointer select-none items-center gap-1.5 rounded-lg border border-[var(--wb-border)] px-2.5 py-1.5 text-sm text-[var(--wb-text)] hover:bg-[var(--wb-hover)]"
            :class="isDimSelected(f.field) ? 'border-[var(--wb-primary)] bg-[var(--wb-primary-soft)]' : ''"
          >
            <input type="checkbox" class="accent-[var(--wb-primary)]" :checked="isDimSelected(f.field)" @change="toggleDim(f)" />
            {{ f.label }}
            <select
              v-if="f.date && isDimSelected(f.field)"
              class="wb-input !w-auto !px-1 !py-0.5 !text-xs"
              :value="dimBucketOf(f.field)"
              @click.stop
              @change="setBucket(f.field, ($event.target as HTMLSelectElement).value as DateBucket)"
            >
              <option value="year">按年</option>
              <option value="month">按月</option>
              <option value="day">按日</option>
            </select>
          </label>
        </div>
        <div v-if="selectedDims.length" class="mt-2 flex flex-wrap items-center gap-2">
          <span class="text-xs text-[var(--wb-text-muted)]">维度顺序：</span>
          <span
            v-for="(d, i) in selectedDims"
            :key="dimensionId(d)"
            class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--wb-primary-soft)] px-2 py-1 text-xs text-[var(--wb-text)]"
          >
            {{ fieldLabel(d.field) }}{{ d.bucket ? '(' + DATE_BUCKET_LABEL[d.bucket] + ')' : '' }}
            <button
              class="text-[var(--wb-text-muted)] hover:text-[var(--wb-primary)] disabled:opacity-40"
              title="上移"
              :disabled="i === 0"
              @click="moveDim(i, -1)"
            >↑</button>
            <button
              class="text-[var(--wb-text-muted)] hover:text-[var(--wb-primary)] disabled:opacity-40"
              title="下移"
              :disabled="i === selectedDims.length - 1"
              @click="moveDim(i, 1)"
            >↓</button>
          </span>
        </div>
      </div>

      <!-- 汇总指标 -->
      <div>
        <div class="mb-2 text-xs font-medium text-[var(--wb-text-muted)]">汇总指标</div>
        <div class="space-y-2">
          <div class="flex items-center gap-2 text-sm text-[var(--wb-text)]">
            <span class="rounded-lg bg-[var(--wb-surface-2)] px-2 py-1 text-xs">数量（计数）</span>
            <span class="text-xs text-[var(--wb-text-muted)]">固定指标</span>
          </div>
          <div v-for="m in extraMeasures" :key="m.id" class="flex items-center gap-2">
            <select
              class="wb-input !py-1 text-sm"
              :value="m.field"
              @change="setMeasureField(m.id, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="f in metricPool" :key="f.field" :value="f.field">{{ f.label }}</option>
            </select>
            <select
              class="wb-input !py-1 text-sm"
              :value="m.op"
              @change="setMeasureOp(m.id, ($event.target as HTMLSelectElement).value as PivotMeasure['op'])"
            >
              <option value="sum">合计</option>
              <option value="avg">平均</option>
              <option value="max">最大</option>
              <option value="min">最小</option>
              <option value="countDistinct">去重计数</option>
            </select>
            <button class="text-xs text-[var(--wb-danger)] hover:underline" @click="removeMeasure(m.id)">移除</button>
          </div>
          <button
            v-if="metricPool.length"
            class="text-xs text-[var(--wb-primary)] hover:underline"
            @click="addMeasure"
          >
            + 添加汇总指标
          </button>
        </div>
      </div>

      <!-- 结果表 -->
      <div v-if="result.length" class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="border-b border-[var(--wb-border)] text-xs text-[var(--wb-text-muted)]">
            <tr>
              <th
                v-for="d in store.config.pivotDimensions"
                :key="dimensionId(d)"
                class="px-3 py-2 text-left font-normal"
              >
                {{ fieldLabel(d.field) }}{{ d.bucket ? '(' + DATE_BUCKET_LABEL[d.bucket] + ')' : '' }}
              </th>
              <th v-for="m in store.config.pivotMeasures" :key="m.id" class="px-3 py-2 text-right font-normal">
                {{ measureLabel(m) }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(r, rIdx) in result"
              :key="r.key"
              class="cursor-pointer border-b border-[var(--wb-border)] last:border-0 hover:bg-[var(--wb-hover)]"
            >
              <template v-for="(d, c) in store.config.pivotDimensions" :key="dimensionId(d)">
                <td
                  v-if="spanMatrix[rIdx][c] > 0"
                  :rowspan="spanMatrix[rIdx][c] > 1 ? spanMatrix[rIdx][c] : undefined"
                  class="px-3 py-2 align-middle text-[var(--wb-text)]"
                  @click="drill(r, c + 1)"
                >
                  {{ r.dims[dimensionId(d)] || '(空)' }}
                </td>
              </template>
              <td
                v-for="m in store.config.pivotMeasures"
                :key="m.id"
                class="px-3 py-2 text-right text-[var(--wb-text)]"
                @click="drill(r, store.config.pivotDimensions.length)"
              >
                {{ fmt(r.measures[m.id] ?? 0, m.op) }}
              </td>
            </tr>
            <tr class="bg-[var(--wb-surface-2)]">
              <td class="px-3 py-2 text-xs text-[var(--wb-text-muted)]" :colspan="store.config.pivotDimensions.length">
                合计
              </td>
              <td
                v-for="m in store.config.pivotMeasures"
                :key="'t-' + m.id"
                class="px-3 py-2 text-right text-xs font-medium text-[var(--wb-text)]"
              >
                {{ fmt(totalRow.measures[m.id] ?? 0, m.op) }}
              </td>
            </tr>
          </tbody>
        </table>
        <p class="mt-2 text-xs text-[var(--wb-text-muted)]">点击维度单元格按层级查看订单明细，点击数值单元格查看完整组合明细</p>
      </div>
      <p v-else class="text-xs text-[var(--wb-text-muted)]">暂无汇总数据，请先导入并完成识别归类。</p>

      <!-- 钻取明细 -->
      <div v-if="drillRows.length" class="overflow-hidden rounded-lg border border-[var(--wb-border)]">
        <div class="flex items-center justify-between bg-[var(--wb-surface-2)] px-3 py-2 text-xs text-[var(--wb-text)]">
          <span>
            钻取明细：{{ drillTitle }} <b class="text-[var(--wb-primary)]">{{ drillRows.length }}</b> 条
          </span>
          <button class="text-[var(--wb-text-muted)] hover:text-[var(--wb-danger)]" @click="drillRows = []">关闭 ✕</button>
        </div>
        <div class="max-h-64 overflow-auto">
          <table class="w-full text-xs">
            <thead class="border-b border-[var(--wb-border)] text-[var(--wb-text-muted)]">
              <tr>
                <th class="px-3 py-1.5 text-left font-normal">图</th>
                <th class="px-3 py-1.5 text-left font-normal">订单号</th>
                <th class="px-3 py-1.5 text-left font-normal">店铺</th>
                <th class="px-3 py-1.5 text-left font-normal">下单时间</th>
                <th class="px-3 py-1.5 text-left font-normal">尺寸</th>
                <th class="px-3 py-1.5 text-left font-normal">款式名</th>
                <th class="px-3 py-1.5 text-left font-normal">款色</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="o in drillRows"
                :key="o.id"
                class="border-b border-[var(--wb-border)] last:border-0"
              >
                <td class="px-3 py-1.5"><OrderThumb :path="o.localPath" size="sm" /></td>
                <td class="px-3 py-1.5 text-[var(--wb-text)]">{{ o.orderNo }}</td>
                <td class="px-3 py-1.5 text-[var(--wb-text)]">{{ o.shop }}</td>
                <td class="px-3 py-1.5 text-[var(--wb-text)]">{{ o.orderTime }}</td>
                <td class="px-3 py-1.5 text-[var(--wb-text)]">{{ o.size }}</td>
                <td class="px-3 py-1.5 text-[var(--wb-text)]">{{ o.styleName || o.category }}</td>
                <td class="px-3 py-1.5 text-[var(--wb-text)]">{{ o.styleColor || o.color }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
