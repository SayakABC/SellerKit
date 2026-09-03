<template>
  <div class="h-full flex flex-col bg-[var(--wb-bg)]">
    <!-- ===== 模块级 Tab 导航（固定顶栏；概览 / 拿货对账 / 数据纠正 / 产品库 / 订单明细共用同一位置与视觉） ===== -->
    <div
      class="shrink-0 flex items-center gap-3 border-b border-[var(--wb-border)] bg-[var(--wb-surface)]/60 px-6 py-3"
    >
      <div
        class="flex items-center gap-1 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-1 shadow-sm"
      >
        <button
          v-for="t in tabs"
          :key="t.id"
          class="h-8 px-4 rounded-lg text-sm transition-colors flex items-center gap-1.5"
          :class="
            activeTab === t.id
              ? 'bg-[var(--wb-primary-soft)] text-[var(--wb-primary)] font-medium'
              : 'text-[var(--wb-text-muted)] hover:text-[var(--wb-text)]'
          "
          @click="onTabClick(t)"
        >
          {{ t.label }}
          <span
            v-if="t.badgeKey && stats[t.badgeKey] > 0"
            class="min-w-[18px] h-[18px] px-1 rounded-full text-[11px] leading-[18px] text-center bg-[var(--wb-warning)] text-white"
          >
            {{ stats[t.badgeKey] }}
          </span>
        </button>
        <div class="mx-1 h-5 w-px bg-[var(--wb-border)]"></div>
        <button
          class="h-8 w-8 rounded-lg flex items-center justify-center text-[var(--wb-text-muted)] transition-colors hover:text-[var(--wb-text)] hover:bg-[var(--wb-hover)]"
          title="引擎配置"
          @click="openSettings"
        >
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>

    <!-- ===== 内容区 ===== -->
    <!-- 拿货对账：整高工作台（内部各栏独立滚动） -->
    <template v-if="activeTab === 'stock-in'">
      <div class="min-h-0 flex-1 p-6">
        <StockInView :request="stockInRequest" />
      </div>
    </template>
    <!-- 其它页面：居中卡片流，整页纵向滚动 -->
    <template v-else>
      <div class="min-h-0 flex-1 overflow-y-auto p-6">
        <div class="max-w-5xl mx-auto space-y-4">
          <!-- 流程步骤条 -->
          <StepsBar
            @goto-library="gotoLibrary"
            @goto-summary="gotoSummary"
            @goto-correction="gotoCorrection"
          />

        <!-- ============ 概览 ============ -->
        <template v-if="activeTab === 'overview'">
          <!-- KPI 统计条 -->
          <div
            v-if="stats.total || store.styles.length"
            class="grid grid-cols-2 md:grid-cols-5 gap-3"
          >
            <div
              v-for="s in statCards"
              :key="s.key"
              class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4 shadow-sm"
            >
              <div class="text-xs text-[var(--wb-text-muted)]">{{ s.label }}</div>
              <div class="mt-1 text-2xl font-semibold text-[var(--wb-text)]">{{ stats[s.key] }}</div>
            </div>
          </div>

          <!-- 进度 -->
          <div
            v-if="store.processing || store.progress.total"
            class="rounded-xl border border-[var(--wb-border)] bg-[var(--wb-surface)] p-4 shadow-sm"
          >
            <div class="flex items-center justify-between gap-3 text-xs text-[var(--wb-text-muted)] mb-1.5">
              <span class="min-w-0 truncate">{{ store.progress.current || '准备中…' }}</span>
              <span class="flex shrink-0 items-center gap-2">
                <button
                  v-if="store.processing"
                  class="rounded border border-[var(--wb-danger)] px-2 py-0.5 font-medium text-[var(--wb-danger)] transition-colors hover:bg-[var(--wb-danger)]/10"
                  @click="store.requestCancel()"
                >停止</button>
                <span>
                  成功 {{ store.progress.done }} / 失败 {{ store.progress.failed }}
                  <template v-if="store.progress.missing"> / 缺图 {{ store.progress.missing }}</template>
                  / 共 {{ store.progress.total }}
                </span>
              </span>
            </div>
            <!-- 识别来源统计：本地匹配命中（指纹库/识别结果复用，未调 AI） vs AI 识别（实际调用视觉模型） -->
            <div class="mb-2 flex items-center gap-3 text-[11px]">
              <span class="rounded bg-[var(--wb-success)]/10 px-1.5 py-0.5 text-[var(--wb-success)]">
                本地匹配 {{ store.progress.localHit }}
              </span>
              <span class="rounded bg-[var(--wb-primary)]/10 px-1.5 py-0.5 text-[var(--wb-primary)]">
                AI 识别 {{ store.progress.aiHit }}
              </span>
            </div>
            <div class="h-2 rounded-full bg-[var(--wb-surface-2)] overflow-hidden">
              <div
                class="h-full bg-[var(--wb-primary)] transition-all duration-300"
                :style="{ width: pct + '%' }"
              ></div>
            </div>

            <!-- 本次运行失败明细（即时诊断用，完整失败清单见下方「失败记录」持久卡） -->
            <div
              v-if="store.failLogs.length"
              class="mt-3 rounded-lg border border-[var(--wb-danger)]/40 bg-[var(--wb-surface-2)]/60 p-2.5"
            >
              <div class="flex items-center justify-between text-xs">
                <span class="font-medium text-[var(--wb-danger)]">本次失败 {{ store.failLogs.length }} 条（明细最多保留 50 条，完整清单已入队列）</span>
                <button
                  class="rounded border border-[var(--wb-border)] px-1.5 py-0.5 hover:bg-[var(--wb-hover)]"
                  @click="copyFailLogs"
                >
                  复制明细
                </button>
              </div>
              <ul class="mt-1.5 max-h-36 space-y-1 overflow-auto pr-1">
                <li
                  v-for="(f, i) in store.failLogs"
                  :key="i"
                  class="text-[11px] leading-relaxed text-[var(--wb-text-muted)]"
                >
                  <span class="break-all">{{ f.url }}</span>
                  <span class="text-[var(--wb-danger)]"> → {{ f.error }}</span>
                </li>
              </ul>
            </div>
          </div>

          <!-- 缺图待补（队列中保留的空图片记录：补图后重跑「图片识别」即可处理；重启不丢；服务端按 missingOnly 分页统计） -->
          <div
            v-if="store.queueMissingTotal > 0"
            class="rounded-xl border border-[var(--wb-warning)]/60 bg-[var(--wb-surface)] p-4 shadow-sm"
          >
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-[var(--wb-text)]">缺图待补</span>
              <span class="text-xs text-[var(--wb-text-muted)]">{{ store.queueMissingTotal }} 条记录无图片链接，补图后点击「② 图片识别」重新处理（记录已持久化，重启不丢）</span>
            </div>
            <div class="mt-3 space-y-2">
              <div
                v-for="r in missingPreview"
                :key="r.id"
                class="flex items-center gap-2"
              >
                <span
                  class="w-36 shrink-0 truncate text-xs text-[var(--wb-text-muted)]"
                  :title="r.orderNo || '无订单号'"
                >{{ r.orderNo || '无订单号' }}</span>
                <span
                  class="hidden md:block w-56 shrink-0 truncate text-xs text-[var(--wb-text-muted)]"
                  :title="r.info"
                >{{ r.info || '（无产品信息）' }}</span>
                <input
                  v-model="patchUrls[r.id]"
                  type="text"
                  placeholder="粘贴该产品的图片链接 https://…"
                  class="h-8 min-w-0 flex-1 rounded-lg border border-[var(--wb-border)] bg-transparent px-2 text-sm focus:border-[var(--wb-primary)] focus:outline-none"
                  @keyup.enter="savePatch(r.id)"
                />
                <button
                  class="h-8 shrink-0 rounded-lg bg-[var(--wb-primary)] px-3 text-xs font-medium text-[var(--wb-primary-contrast)] transition-colors hover:bg-[var(--wb-primary-hover)]"
                  @click="savePatch(r.id)"
                >保存</button>
              </div>
              <p
                v-if="store.queueMissingTotal > store.queueMissingRows.length"
                class="text-[11px] text-[var(--wb-text-muted)]"
              >
                …其余 {{ store.queueMissingTotal - store.queueMissingRows.length }} 条缺图较多，建议在原 Excel 补齐图片链接后重新导入。
              </p>
            </div>
          </div>

          <!-- 失败记录（持久化在识别队列，重启不丢；成功记录处理完自动清理） -->
          <div
            v-if="store.queueCounts.error > 0"
            class="rounded-xl border border-[var(--wb-danger)]/50 bg-[var(--wb-surface)] p-4 shadow-sm"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="text-sm">
                <span class="font-medium text-[var(--wb-danger)]">失败记录 {{ store.queueCounts.error }} 条</span>
                <span class="ml-2 text-xs text-[var(--wb-text-muted)]">已持久化到识别队列，重启不丢；重试成功后自动清除</span>
              </div>
              <button
                class="h-8 rounded-lg bg-[var(--wb-danger)] px-3 text-xs font-medium text-[var(--wb-primary-contrast)] transition-colors hover:opacity-90 disabled:opacity-50"
                :disabled="store.processing"
                @click="store.runProcess()"
              >重试失败（成功的自动跳过）</button>
            </div>
            <ul class="mt-2 max-h-40 space-y-1 overflow-auto pr-1">
              <li
                v-for="q in errorPreview"
                :key="q.id"
                class="text-[11px] leading-relaxed text-[var(--wb-text-muted)]"
              >
                <span class="break-all">{{ q.url }}</span>
                <span class="text-[var(--wb-danger)]"> → {{ q.error }}</span>
                <span v-if="q.failCount > 1" class="text-[var(--wb-warning)]">（第 {{ q.failCount }} 次失败）</span>
              </li>
            </ul>
            <p v-if="store.queueCounts.error > errorPreview.length" class="mt-1 text-[11px] text-[var(--wb-text-muted)]">
              …其余 {{ store.queueCounts.error - errorPreview.length }} 条失败原因相同或类似，可在设置中先验证引擎配置，再统一重试。
            </p>
          </div>

          <!-- 数据汇总（透视） -->
          <div id="summary-anchor" class="scroll-mt-4">
            <PivotPanel v-if="store.orders.length" @open-stock-in="onPivotStockIn" />
          </div>

          <p
            v-if="!store.queueCounts.total && !store.orders.length"
            class="text-center text-sm text-[var(--wb-text-muted)] py-12"
          >
            点击上方步骤条「① 上传订单」导入 Excel（含主图 URL 列），再点「② 图片识别」自动提取款式 / 颜色 / logo 并按维度汇总。
          </p>

          <!-- 已导入、尚未识别：给出明确反馈，避免误以为导入失败 -->
          <div
            v-else-if="store.queueCounts.total && !store.orders.length"
            class="rounded-xl border border-dashed border-[var(--wb-primary)]/60 bg-[var(--wb-primary-soft)]/50 p-6 text-center"
          >
            <p class="text-sm font-medium text-[var(--wb-text)]">
              已导入 {{ store.queueCounts.total }} 条记录（已入待识别队列）
            </p>
            <p class="mt-1 text-xs text-[var(--wb-text-muted)]">
              数据解析完成，点上方步骤条「② 图片识别」自动提取款式 / 颜色 / logo，完成后即可看到统计汇总。失败 / 缺图记录会保留在队列中，重启不丢、可随时重试。
            </p>
          </div>

          <!-- 数据维护（低优先级）：清理不再被数据库引用的孤儿图片缓存（重置/批次覆盖后遗留） -->
          <div v-if="!store.processing && !store.queueCounts.pending" class="pt-1 text-right">
            <button
              class="text-[11px] text-[var(--wb-text-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--wb-text)]"
              title="扫描图片缓存目录，删除未被任何订单/队列引用的文件（不影响现有数据）"
              @click="cleanupOrphanImages"
            >清理未引用图片缓存</button>
          </div>
        </template>

        <!-- ============ 数据纠正（步骤③） ============ -->
        <CorrectionView
          v-if="activeTab === 'correction'"
          @goto-summary="gotoSummary"
        />

        <!-- ============ 产品库 ============ -->
        <ProductLibraryView v-if="activeTab === 'library'" />

        <!-- ============ 订单明细 ============ -->
        <OrderDetailTable v-if="activeTab === 'orders'" />
      </div>
    </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useOrderInsightStore } from './store';
import { writeClipboard } from '@/core/services/clipboard';
import { toast } from '@/core/services/toast';
import PivotPanel from './components/PivotPanel.vue';
import ProductLibraryView from './components/ProductLibraryView.vue';
import CorrectionView from './components/CorrectionView.vue';
import OrderDetailTable from './components/OrderDetailTable.vue';
import StepsBar from './components/StepsBar.vue';
import StockInView from './stock-in/StockInView.vue';
import type { PurchaseSourceRow } from '@/types';
import type { StockInIntent } from './stock-in/store';

const store = useOrderInsightStore();

const tabs = [
  { id: 'overview', label: '概览' },
  { id: 'stock-in', label: '拿货对账' },
  { id: 'correction', label: '数据纠正', badgeKey: 'pending' as const },
  { id: 'library', label: '产品库' },
  { id: 'orders', label: '订单明细' },
];
const activeTab = ref<string>('overview');

type OrderTab = { id: string; label: string; badgeKey?: 'pending' };

/** 下发给内嵌 StockInView 的进入意图：n 自增保证重复动作可被消费（v-if 挂载前设置同样生效） */
const stockInRequest = ref<StockInIntent | null>(null);

/** 打开「拿货对账」子页：sub 定位拿货/对账子 Tab；draftRows 为「生成拿货单」来源订单行（当前筛选订单明细） */
function openStockInTab(opts: { sub?: 'purchase' | 'recon'; draftRows?: PurchaseSourceRow[] } = {}) {
  stockInRequest.value = { n: (stockInRequest.value?.n ?? 0) + 1, sub: opts.sub, draftRows: opts.draftRows };
  activeTab.value = 'stock-in';
}

/** 汇总面板「生成拿货单」→ 切到拿货子页并新建草稿 */
function onPivotStockIn(rows: PurchaseSourceRow[]) {
  openStockInTab({ sub: 'purchase', draftRows: rows });
}

/** Tab 点击：全部本地页签切换；「拿货对账」默认进入对账子页（对齐原模块视图） */
function onTabClick(t: OrderTab) {
  if (t.id === 'stock-in') {
    openStockInTab({ sub: 'recon' });
    return;
  }
  activeTab.value = t.id;
}

/** KPI 统计：总数/待纠正用服务端 COUNT（loadAggregates），已归类/款色与透视镜像同源保持一致 */
const stats = computed(() => {
  const matched = store.orders.filter((o) => o.styleCode).length;
  const colorCount = store.styles.reduce((n, s) => n + s.colors.length, 0);
  return {
    total: store.orderTotal,
    matched,
    pending: store.pendingTotal,
    styles: store.styles.length,
    colors: colorCount,
  };
});

const statCards = [
  { key: 'total', label: '总订单' },
  { key: 'matched', label: '已归类' },
  { key: 'pending', label: '待纠正' },
  { key: 'styles', label: '款编码' },
  { key: 'colors', label: '款色' },
] as const;

const pct = computed(() => {
  if (!store.progress.total) return 0;
  return Math.round(((store.progress.done + store.progress.failed + store.progress.missing) / store.progress.total) * 100);
});

/** 孤儿图片清理：仅删除缓存目录中不再被 DB（oi_images ∪ oi_queue）引用的文件；破坏性操作需二次确认 */
async function cleanupOrphanImages() {
  if (store.processing) return;
  if (!window.confirm('将删除「图片识别」缓存目录中不再被任何订单/队列引用的图片文件（通常来自重置数据或批次覆盖）。只删除未引用文件，不影响现有订单与产品库。是否继续？')) {
    return;
  }
  const r = await store.cleanupOrphanImages();
  if (!r) return;
  if (!r.deleted) {
    toast('没有可清理的孤儿图片', 'info');
    return;
  }
  toast(`已清理 ${r.deleted} 个孤儿图片文件，释放 ${(r.freedBytes / 1024 / 1024).toFixed(1)} MB`, 'success');
}

/** 复制本次识别的失败明细（url + 原因），便于发给排查/比对失败图是否同源 */
async function copyFailLogs() {
  const text = store.failLogs
    .map((f, i) => `${i + 1}. ${f.url}\n   原因: ${f.error}`)
    .join('\n');
  const ok = await writeClipboard(text || '无失败记录');
  if (ok) toast(`已复制 ${store.failLogs.length} 条失败明细`, 'success');
}

/** 缺图补图输入框草稿（队列行 id -> url） */
const patchUrls = ref<Record<number, string>>({});

/** 保存补图：写回持久化队列（主进程同步回写 URL 并把行转回 pending），成功后清空输入框 */
async function savePatch(id: number) {
  const url = patchUrls.value[id] ?? '';
  if (!url.trim()) return;
  const ok = await store.setMissingImageUrl(id, url);
  if (ok) delete patchUrls.value[id];
}

/** 缺图补图列表（服务端 missingOnly 预览窗口，最多 QUEUE_PREVIEW_LIMIT 行；完整统计看 queueMissingTotal） */
const missingPreview = computed(() => store.queueMissingRows);

/** 持久失败记录列表（服务端 status='error' 预览窗口，最多 QUEUE_PREVIEW_LIMIT 行；完整统计看 queueCounts.error） */
const errorPreview = computed(() => store.queueErrorRows);

function openSettings() {
  window.dispatchEvent(new CustomEvent('open-settings', { detail: { category: 'order-insight' } }));
}

/** 步骤③ 数据纠正 → 切到纠正 Tab */
function gotoCorrection() {
  activeTab.value = 'correction';
}

/** 图片识别流程结束 → 自动定位到「数据纠正」Tab。
 * 仅当确有成功识别（done > 0）且非用户/短路停止时跳转；全失败/全缺图留在概览看失败明细。 */
watch(
  () => store.processTicks,
  () => {
    if (store.progress.total > 0 && store.progress.done > 0 && !store.lastRunCancelled) {
      activeTab.value = 'correction';
    }
  },
);

/** 步骤③ 完成 → 切到产品库 Tab（查看核对款编码） */
function gotoLibrary() {
  activeTab.value = 'library';
}

/** 步骤④ 筛选统计 → 切回概览并滚动到汇总面板 */
function gotoSummary() {
  activeTab.value = 'overview';
  nextTick(() => {
    document.getElementById('summary-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/** 进入「数据汇总」概览时：行级操作（纠正/删除/发货等）只做轻量同步，镜像可能过期；
 * 透视与导出依赖全量订单镜像，故在切回概览时按 ordersDirty 触发一次全量同步，保证统计口径最新。 */
watch(activeTab, async (tab) => {
  if (tab === 'overview' && store.ordersDirty) {
    await store.refreshStats();
  }
});

onMounted(async () => {
  await store.loadState();
  await store.refreshStats();
  // 重启恢复：若存在上次遗留的失败/缺图/待处理批次，自动载入概览（失败记录卡/缺图卡），保证不丢单
  await store.restoreLastQueue();
});
</script>
