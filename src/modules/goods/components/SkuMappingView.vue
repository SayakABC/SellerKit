<template>
  <div class="gd-map">
    <div class="gd-toolbar">
      <!-- 分段控件代替岛时代的胶囊页签：这两块是**互斥视图**而不是"另一个页面"，
           分段控件在视觉上更准确地表达"同一份数据的两面"。 -->
      <div class="wb-seg" role="tablist" aria-label="映射视图">
        <button
          type="button"
          role="tab"
          class="wb-seg__item"
          data-act="sub-queue"
          :class="{ 'is-on': sub === 'queue' }"
          :aria-selected="sub === 'queue'"
          @click="sub = 'queue'"
        >
          待关联队列
          <span v-if="qStats?.unmapped" class="wb-seg__badge">{{ qStats.unmapped }}</span>
        </button>
        <button
          type="button"
          role="tab"
          class="wb-seg__item"
          data-act="sub-mapped"
          :class="{ 'is-on': sub === 'mapped' }"
          :aria-selected="sub === 'mapped'"
          @click="sub = 'mapped'"
        >
          已建立映射
          <span v-if="mSummary?.total" class="wb-seg__badge wb-seg__badge--plain">
            {{ mSummary.total }}
          </span>
        </button>
      </div>

      <span v-if="loading" class="wb-muted gd-toolbar__hint">读取中…</span>

      <div class="gd-toolbar__actions">
        <button class="wb-btn" type="button" data-act="map-refresh" :disabled="busy || loading" @click="manualRefresh">
          刷新
        </button>
      </div>
    </div>

    <!-- 统计条：这一条是**当前交付口径的画像**（待办 / 阻塞 / 已完成 / 覆盖率）。
         关联率的分母刻意用 `groups`（= 已关联 + 待关联 + 店铺未归一，主进程保证这个恒等式），
         而不是"已确认映射条数"——后者会把已经没有订单的历史映射算进去，比率虚高到看不出问题。 -->
    <div class="wb-metabar" data-act="map-stats">
      <span class="wb-metric" :class="{ 'is-warn': (qStats?.unmapped ?? 0) > 0 }">
        待关联 <b>{{ qStats?.unmapped ?? 0 }}</b>
      </span>
      <span class="wb-metric" :class="{ 'is-warn': unresolvedShops.length > 0 }">
        店铺未归一 <b>{{ qStats?.shopUnresolved ?? 0 }}</b>
      </span>
      <span class="wb-metric"> 已关联 <b>{{ qStats?.mapped ?? 0 }}</b> </span>
      <span class="wb-metric"> 关联率 <b>{{ rateText }}</b> </span>
      <span class="wb-metric"> 映射记录 <b>{{ mSummary?.total ?? 0 }}</b> </span>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error">{{ error }}</p>

    <!-- 行级失败**不能只弹 toast**：用户要照着一行行去改，一闪而过等于没报 -->
    <div v-if="failures.length" class="wb-notice wb-notice--error gd-failures" data-act="map-failures">
      <div>有 <b>{{ failures.length }}</b> 行没能写入：</div>
      <ul>
        <li v-for="(f, i) in failures" :key="i">
          <span class="wb-mono">{{ f.itemId }}</span> —— {{ f.message }}
        </li>
      </ul>
    </div>

    <!-- ── 待关联队列 ─────────────────────────────────────────────── -->
    <template v-if="sub === 'queue'">
      <div v-if="hasQueueHints" class="gd-hints">
        <p v-if="unresolvedShops.length" class="wb-notice wb-notice--warn">
          下面这些店铺还没归一，它们的商品<b>无法</b>写映射（订单里没有平台，平台只能从店铺实体取）：
          <b>{{ unresolvedShops.join('、') }}</b>
          。请先到「店铺账号管家」的「店铺登记」把门店认下来，再回来刷新。
        </p>
        <p v-if="qStats?.truncated" class="wb-notice wb-notice--warn">
          订单行数超过单次扫描上限（50000 行），本次队列可能不完整。建议先按时间分批导入订单。
        </p>
        <p v-if="(qStats?.withoutItemId ?? 0) > 0" class="wb-notice">
          另有 <b>{{ qStats?.withoutItemId }}</b> 行订单取不到商品ID（列名不匹配或值为空），
          它们<b>不会</b>出现在队列里 —— 这是「丢行」而不是「已完成」。
        </p>
      </div>

      <div class="gd-toolbar gd-toolbar--sub">
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="queue-batch"
          :disabled="busy || !selectedUnmapped.length"
          @click="openBatchPicker"
        >
          批量关联选中 {{ selectedUnmapped.length }} 项…
        </button>
        <button
          class="wb-btn"
          type="button"
          data-act="queue-clear"
          :disabled="busy || !selectedKeys.size"
          @click="clearSelection"
        >
          清空选择
        </button>
        <button
          v-if="(qStats?.groups ?? 0) > (qStats?.shown ?? 0)"
          class="wb-btn"
          type="button"
          data-act="queue-more"
          :disabled="busy || loading"
          @click="showMore"
        >
          显示更多
        </button>
        <span class="wb-muted gd-toolbar__hint">
          共 {{ qStats?.groups ?? 0 }} 组待处理，已列出 {{ qStats?.shown ?? 0 }} 组
        </span>
      </div>

      <section class="wb-panel gd-panel">
        <div class="wb-panel__body">
          <table class="wb-table" data-act="queue-table">
            <thead>
              <tr>
                <th class="gd-c-check">
                  <input
                    type="checkbox"
                    :checked="allQueueChecked"
                    :indeterminate.prop="someQueueChecked"
                    :disabled="!selectableQueue.length"
                    aria-label="全选可关联行"
                    @change="toggleQueueAll"
                  />
                </th>
                <th>店铺</th>
                <th>平台</th>
                <th>商品ID</th>
                <th>商品标题</th>
                <th class="wb-num">订单行</th>
                <th>状态</th>
                <th class="gd-c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in queueRows"
                :key="queueKey(r)"
                :data-item-id="r.itemId"
                :class="{ 'is-blocked': r.status !== 'unmapped' }"
              >
                <td class="gd-c-check">
                  <input
                    type="checkbox"
                    :checked="selectedKeys.has(queueKey(r))"
                    :disabled="r.status !== 'unmapped'"
                    :aria-label="`选择 ${r.itemId}`"
                    @change="toggleQueueOne(r)"
                  />
                </td>
                <td>
                  <template v-if="r.shopId">{{ r.shopName || `#${r.shopId}` }}</template>
                  <span v-else class="wb-muted" :title="`订单里的店铺原文：${r.shopRaw || '（空）'}`">
                    {{ r.shopRaw || '（无店铺名）' }}
                  </span>
                </td>
                <td>
                  <span v-if="r.platform" class="wb-tag">{{ r.platform }}</span>
                  <span v-else class="wb-muted">—</span>
                </td>
                <td class="wb-mono">{{ r.itemId }}</td>
                <td :class="{ 'wb-muted': !r.title }">{{ r.title || '—' }}</td>
                <td class="wb-num">{{ r.orderCount }}</td>
                <td>
                  <span v-if="r.status === 'unmapped'" class="wb-tag is-warn">待关联</span>
                  <span v-else class="wb-tag">店铺未归一</span>
                  <span v-if="r.autoShopName" class="gd-note">
                    疑似 {{ r.autoShopName }}<template v-if="r.autoShopPlatform">（{{ r.autoShopPlatform }}）</template>
                  </span>
                </td>
                <td class="gd-c-ops">
                  <template v-if="r.status === 'unmapped'">
                    <button class="wb-link" type="button" data-act="row-relate" :disabled="busy" @click="openRowPicker(r)">
                      关联…
                    </button>
                  </template>
                  <template v-else>
                    <button
                      class="wb-link"
                      type="button"
                      data-act="row-blocked"
                      disabled
                      :title="`先到「店铺账号管家」的「店铺登记」把「${r.shopRaw}」归一，再回来处理`"
                    >
                      需先登记店铺
                    </button>
                  </template>
                </td>
              </tr>
              <tr v-if="!queueRows.length && !loading">
                <td colspan="8" class="gd-panel__empty">
                  <div class="wb-empty">
                    <div class="wb-empty__icon" aria-hidden="true">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    </div>
                    <p class="wb-empty__title">
                      {{ qStats?.groups ? '这一批待处理项都已关联完' : '队列是空的' }}
                    </p>
                    <p class="wb-empty__desc">
                      {{
                        qStats?.groups
                          ? '还有更多组没列出来时，点上面的「显示更多」继续。'
                          : '队列不是缓存表，而是**实时**从订单里聚出来的：导入订单后，出现过的「店铺 × 商品ID」会在这里等着确认。'
                      }}
                    </p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- ── 已建立映射 ─────────────────────────────────────────────── -->
    <template v-else>
      <div class="gd-toolbar gd-toolbar--sub">
        <input
          v-model="mSearchInput"
          class="wb-input gd-toolbar__search"
          type="search"
          placeholder="搜索商品ID / 平台 / 备注…"
          aria-label="搜索映射"
        />
        <select v-model="mStatus" class="wb-input gd-toolbar__select" aria-label="状态筛选">
          <option value="">全部状态</option>
          <option value="confirmed">已确认</option>
          <option value="pending">待确认</option>
          <option value="invalid">已失效</option>
        </select>
        <select v-model="mShop" class="wb-input gd-toolbar__select" aria-label="店铺筛选">
          <option value="">全部店铺</option>
          <option v-for="s in shopOptions" :key="s.shopId || 'unknown'" :value="String(s.shopId)">
            {{ s.shopName || `#${s.shopId}（店铺已删）` }}（{{ s.count }}）
          </option>
        </select>
        <span v-if="loading" class="wb-muted gd-toolbar__hint">读取中…</span>
      </div>

      <section class="wb-panel gd-panel">
        <div class="wb-panel__body">
          <table class="wb-table" data-act="mapped-table">
            <thead>
              <tr>
                <th>店铺</th>
                <th>平台</th>
                <th class="gd-c-img">图</th>
                <th>商品ID</th>
                <th>关联产品</th>
                <th>状态</th>
                <th>来源</th>
                <th>更新时间</th>
                <th class="gd-c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in mappedRows" :key="r.id" :data-item-id="r.itemId" :data-map-id="r.id">
                <td :class="{ 'wb-muted': !r.shopName }">
                  {{ r.shopName || `#${r.shopId}（店铺已删）` }}
                </td>
                <td>
                  <span v-if="r.platform" class="wb-tag">{{ r.platform }}</span>
                  <span v-else class="wb-muted">—</span>
                </td>
                <td class="gd-c-img">
                  <img
                    v-if="itemThumbs.get(r.itemId)"
                    :src="itemThumbs.get(r.itemId)"
                    class="wb-thumb"
                    :title="itemThumbSource.get(r.itemId) || ''"
                    alt=""
                  />
                  <span v-else class="wb-thumb wb-thumb--empty" title="暂无图片"></span>
                  <span class="gd-imgops">
                    <button
                      class="wb-link"
                      type="button"
                      data-act="thumb-set"
                      :disabled="imgBusy"
                      :title="itemOverrides.has(r.itemId) ? '换一张手动覆盖图' : '为该商品ID指定一张图（优先于自动识别）'"
                      @click="pickItemThumb(r.itemId)"
                    >
                      {{ itemOverrides.has(r.itemId) ? '换图' : '设图' }}
                    </button>
                    <button
                      v-if="itemOverrides.has(r.itemId)"
                      class="wb-link"
                      type="button"
                      data-act="thumb-clear"
                      :disabled="imgBusy"
                      @click="clearItemThumb(r.itemId)"
                    >
                      清除
                    </button>
                  </span>
                </td>
                <td class="wb-mono">{{ r.itemId }}</td>
                <td>
                  <span class="wb-mono">{{ r.productCode || '—' }}</span>
                  <span v-if="r.productName" class="gd-note">{{ r.productName }}</span>
                  <span v-if="!r.productCode" class="gd-note">产品已不存在</span>
                </td>
                <td>
                  <span class="wb-tag" :class="STATUS_CLASS[r.status] || ''">
                    {{ STATUS_LABEL[r.status] || r.status }}
                  </span>
                </td>
                <td class="wb-muted">{{ SOURCE_LABEL[r.source] || r.source }}</td>
                <td class="wb-muted gd-nowrap">{{ r.updatedAt }}</td>
                <td class="gd-c-ops">
                  <button class="wb-link" type="button" data-act="row-rebind" :disabled="busy" @click="openRebindPicker(r)">
                    改绑
                  </button>
                  <button
                    v-if="r.status === 'invalid'"
                    class="wb-link"
                    type="button"
                    data-act="row-restore"
                    :disabled="busy"
                    @click="restore(r)"
                  >
                    恢复
                  </button>
                  <button
                    v-else
                    class="wb-link wb-link--danger"
                    type="button"
                    data-act="row-invalidate"
                    :disabled="busy"
                    @click="pendingInvalidate = r"
                  >
                    标失效
                  </button>
                </td>
              </tr>
              <tr v-if="!mappedRows.length && !loading">
                <td colspan="9" class="gd-panel__empty">
                  <div class="wb-empty">
                    <div class="wb-empty__icon" aria-hidden="true">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                        <path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1" />
                        <path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" />
                      </svg>
                    </div>
                    <p class="wb-empty__title">
                      {{ mappedFiltered ? '没有符合筛选条件的映射' : '还没有任何映射' }}
                    </p>
                    <p class="wb-empty__desc">
                      {{
                        mappedFiltered
                          ? '换个关键字，或把上面的筛选条件清掉再试。'
                          : '到「待关联队列」确认第一批 —— 建立映射后，订单里的商品ID 才能自动落到款上。'
                      }}
                    </p>
                    <div v-if="!mappedFiltered" class="wb-empty__actions">
                      <button class="wb-btn" type="button" @click="sub = 'queue'">去待关联队列</button>
                    </div>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="mappedPages > 1" class="wb-panel__foot wb-pager">
          <span>共 {{ mappedTotal }} 条，第 {{ mPage }} / {{ mappedPages }} 页</span>
          <span class="wb-pager__spacer"></span>
          <button class="wb-btn wb-btn--sm" type="button" :disabled="mPage <= 1 || loading" @click="gotoMapped(mPage - 1)">
            上一页
          </button>
          <button
            class="wb-btn wb-btn--sm"
            type="button"
            :disabled="mPage >= mappedPages || loading"
            @click="gotoMapped(mPage + 1)"
          >
            下一页
          </button>
        </div>
      </section>
    </template>

    <!-- 产品选择器（批量关联 / 改绑共用）；写在两个确认弹层之前，
         但同层级下它总在最后一次打开时后挂载 —— 需要它压在最上面时由调用顺序保证。 -->
    <ProductPicker
      v-if="picker"
      :title="pickerTitle"
      :confirm-text="pickerConfirm"
      :initial-color="pickerInitialColor"
      @close="picker = null"
      @pick="applyPick"
    />

    <!-- 标失效确认 -->
    <ConfirmDialog
      v-if="pendingInvalidate"
      title="标记为已失效"
      confirm-text="确认标失效"
      busy-text="处理中…"
      :busy="busy"
      @close="pendingInvalidate = null"
      @confirm="confirmInvalidate"
    >
      <p>
        将把 <b class="wb-mono">{{ pendingInvalidate.itemId }}</b>
        （{{ pendingInvalidate.shopName || `#${pendingInvalidate.shopId}` }}）标为「已失效」。
      </p>
      <p class="wb-notice wb-notice--warn">
        失效后这条映射不再参与自动命中，但记录会保留。商品ID 变了（例如 Amazon 合并 listing）时用这个
        操作 —— 直接删掉会让关联率莫名回落且查不出原因。
      </p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
// 「映射与关联」页签：店铺商品ID → 产品 的**待关联队列**与**已建立映射**维护。
//
// 三条口径由主进程裁定，界面只呈现、不自己算（迁移时一条都没动）：
//   1. 队列是**实时聚合** `oi_orders` 的商品ID 再减去已生效映射，不是缓存表 ——
//      所以每次写入完成后都要重新拉队列，「关联完就从队列里消失」才是真实状态。
//   2. `店铺未归一` 的行**不给**关联按钮：订单里没有平台字段，平台只能从店铺实体取，
//      拿空平台硬塞会把不同平台的两家店并到同一个键上。这类行只能先去店铺登记。
//   3. 批量关联**一次提交整批**（主进程单事务 + 行级失败逐行回来），不做逐条调用 ——
//      首次导入 500 行未命中是常态，逐条会把 IPC 往返变成瓶颈。
//
// 迁移时的界面改动：
//   · 顶部统计从「好几句 inline 文字」收成一条 `.wb-metabar`（标签 + 数字），扫描更快；
//   · 子视图切换从胶囊页签换成**分段控件**（它们是同一份数据的两面，不是两个页面）；
//   · 提示语从一行小灰字升级成 `.wb-notice`（「订单丢行」「店铺未归一」都是会让数字
//     看起来"完成了"的假象，必须显眼）；每类提示**只在真的命中时**才占位。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as api from '../api';
import { pickImage } from '../productIo';
import { toast } from '@/core/services/toast';
import ProductPicker from './ProductPicker.vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import type { ItemImagePoolEntry, ShopSkuRow, SkuQueueRow, SkuQueueStats, SkuMapSummary } from '@/types';

const emit = defineEmits<{ changed: [payload?: { unmapped?: number }] }>();

const MAPPED_PAGE_SIZE = 50;
/** 队列首屏组数；「显示更多」每次追加这么多（主进程单次上限 1000） */
const QUEUE_STEP = 200;
const QUEUE_MAX = 1000;

const STATUS_LABEL: Record<string, string> = { confirmed: '已确认', pending: '待确认', invalid: '已失效' };
const STATUS_CLASS: Record<string, string> = { confirmed: 'is-on', pending: 'is-warn', invalid: '' };
const SOURCE_LABEL: Record<string, string> = { manual: '手工', import: '导入', ai_suggest: '智能建议' };

const sub = ref<'queue' | 'mapped'>('queue');
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const failures = ref<{ itemId: string; message: string }[]>([]);

// ---- 队列 ----
const queueRows = ref<SkuQueueRow[]>([]);
const qStats = ref<SkuQueueStats | null>(null);
const queueLimit = ref(QUEUE_STEP);
const selectedKeys = ref<Set<string>>(new Set());

// ---- 映射表 ----
const mappedRows = ref<ShopSkuRow[]>([]);
const mappedTotal = ref(0);
const mPage = ref(1);
const mSummary = ref<SkuMapSummary | null>(null);
const mSearchInput = ref('');
const mSearch = ref('');
const mStatus = ref('');
const mShop = ref('');

const picker = ref<{ mode: 'queue'; queue: SkuQueueRow[] } | { mode: 'rebind'; row: ShopSkuRow } | null>(null);
const pendingInvalidate = ref<ShopSkuRow | null>(null);

const unresolvedShops = computed(() => qStats.value?.unresolvedShops ?? []);
const shopOptions = computed(() => mSummary.value?.byShop ?? []);
const hasQueueHints = computed(
  () => unresolvedShops.value.length > 0 || !!qStats.value?.truncated || (qStats.value?.withoutItemId ?? 0) > 0
);

const selectableQueue = computed(() => queueRows.value.filter((r) => r.status === 'unmapped'));
const allQueueChecked = computed(
  () =>
    selectableQueue.value.length > 0 &&
    selectableQueue.value.every((r) => selectedKeys.value.has(queueKey(r)))
);
const someQueueChecked = computed(
  () => !allQueueChecked.value && selectableQueue.value.some((r) => selectedKeys.value.has(queueKey(r)))
);
const selectedUnmapped = computed(() =>
  selectableQueue.value.filter((r) => selectedKeys.value.has(queueKey(r)))
);

const mappedPages = computed(() => Math.max(1, Math.ceil(mappedTotal.value / MAPPED_PAGE_SIZE)));
const mappedFiltered = computed(() => !!mSearch.value || !!mStatus.value || !!mShop.value);

/**
 * 关联率 = 已关联组数 / 全部组数。
 * 分母用 `groups`（主进程保证 = 已关联 + 待关联 + 店铺未归一）而不是"已确认映射条数"：
 * 后者会算进**已经没有订单**的历史映射，比率会虚高到看不出问题。
 */
const rateText = computed(() => {
  const g = qStats.value?.groups ?? 0;
  if (!g) return '—';
  const m = qStats.value?.mapped ?? 0;
  return `${Math.round((m / g) * 100)}%（${m}/${g}）`;
});

/** 队列行的稳定键（主进程按 `(店铺归一键, 商品ID)` 聚合，这里用同一对） */
function queueKey(r: SkuQueueRow): string {
  return `${r.shopKey}\u0000${r.itemId}`;
}

const pickerTitle = computed(() =>
  picker.value?.mode === 'queue' ? `批量关联 ${picker.value.queue.length} 项到产品` : '改绑到产品'
);
const pickerConfirm = computed(() =>
  picker.value?.mode === 'queue' ? `关联这 ${picker.value.queue.length} 项` : '改绑'
);
/** 改绑时预填原色（`spec` 即颜色，`'*'`/空 = 未指定）—— 不预填会把人配好的颜色冲成"未指定" */
const pickerInitialColor = computed(() => {
  const t = picker.value;
  if (!t || t.mode !== 'rebind') return '';
  const s = String(t.row.spec ?? '').trim();
  return s && s !== '*' ? s : '';
});

let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(mSearchInput, (v) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    mSearch.value = v.trim();
    mPage.value = 1;
    void loadMapped();
  }, 300);
});
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});
watch([mStatus, mShop], () => {
  mPage.value = 1;
  void loadMapped();
});
/** 切回队列视图时重拉一次：停在映射页期间别处可能改了店铺归一，表单锚点会失效 */
watch(sub, (v) => {
  if (v === 'queue') void loadQueue();
});

async function loadQueue(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const res = await api.skuQueue({ limit: queueLimit.value });
    queueRows.value = res?.rows ?? [];
    qStats.value = res?.stats ?? null;
    // 每次重拉都清空选择：行会整批消失（刚关联完），留着旧键会指向不存在的行
    selectedKeys.value = new Set();
    // 外壳的页签徽标要的是「待关联数」，只有这一页拉得到队列 —— 由这里回报，外壳不重复扫订单
    emit('changed', { unmapped: qStats.value?.unmapped ?? 0 });
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function loadMapped(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [list, sum] = await Promise.all([
      api.skuList({
        offset: (mPage.value - 1) * MAPPED_PAGE_SIZE,
        limit: MAPPED_PAGE_SIZE,
        search: mSearch.value,
        status: mStatus.value as '' | 'confirmed' | 'pending' | 'invalid',
        shopId: Number(mShop.value) || 0,
      }),
      api.skuSummary(),
    ]);
    mappedRows.value = list?.rows ?? [];
    mappedTotal.value = list?.total ?? 0;
    mSummary.value = sum ?? null;
    if (!mappedRows.value.length && mPage.value > 1) {
      mPage.value = Math.max(1, mPage.value - 1);
      await loadMapped();
      return;
    }
    void loadItemThumbs();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

// ---- 映射列表的商品ID图片（三层回落：手动覆盖图 → 订单识别图 → 款主图）----
// 主进程一次算好回落结果（`itemImagePool`），这里只挑"首选"那张并合批取缩略图。
const itemThumbs = ref(new Map<string, string>());
/** 有手动覆盖图的商品ID集合（显示「换图 / 清除」而不是「设图」） */
const itemOverrides = ref(new Set<string>());
/** 缩略图 title 里的来源说明 */
const itemThumbSource = ref(new Map<string, string>());
const imgBusy = ref(false);

function pickFirst(entry: ItemImagePoolEntry | undefined): { localPath: string; source: string } | null {
  if (!entry) return null;
  if (entry.override) return { localPath: entry.override.localPath, source: '手动上传的覆盖图' };
  if (entry.order?.length) return { localPath: entry.order[0].localPath, source: '订单识别图（自动）' };
  if (entry.product) return { localPath: entry.product.localPath, source: '产品主图' };
  return null;
}

async function loadItemThumbs(): Promise<void> {
  const ids = [...new Set(mappedRows.value.map((r) => r.itemId).filter(Boolean))];
  const thumbs = new Map<string, string>();
  const overrides = new Set<string>();
  const sources = new Map<string, string>();
  if (ids.length) {
    try {
      const pool = (await api.itemImagePool(ids))?.pool ?? {};
      const chosen = ids
        .map((id) => ({ id, hit: pickFirst(pool[id]) }))
        .filter((x): x is { id: string; hit: { localPath: string; source: string } } => !!x.hit);
      for (const { id, hit } of chosen) sources.set(id, hit.source);
      for (const [id, entry] of Object.entries(pool)) {
        if (entry?.override) overrides.add(id);
      }
      if (chosen.length) {
        // 合批取缩略图：dataUrls 顺序与请求 items 一致，单项失败为 null（界面显示空占位）
        const r = await api.imageThumbBatch(chosen.map(({ hit }) => ({ localPath: hit.localPath })));
        (r?.dataUrls ?? []).forEach((url, i) => {
          if (url) thumbs.set(chosen[i].id, url);
        });
      }
    } catch {
      // 取图失败不挡映射列表：空占位展示
    }
  }
  itemThumbs.value = thumbs;
  itemOverrides.value = overrides;
  itemThumbSource.value = sources;
}

async function pickItemThumb(itemId: string): Promise<void> {
  if (imgBusy.value) return;
  let srcPath: string | null = null;
  try {
    srcPath = await pickImage();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
    return;
  }
  if (!srcPath) return; // 用户取消
  imgBusy.value = true;
  try {
    await api.itemImageSet(itemId, srcPath);
    toast(`已为 ${itemId} 设置覆盖图`, 'success');
    await loadItemThumbs();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    imgBusy.value = false;
  }
}

async function clearItemThumb(itemId: string): Promise<void> {
  if (imgBusy.value) return;
  imgBusy.value = true;
  try {
    await api.itemImageClear(itemId);
    toast(`已清除 ${itemId} 的覆盖图（回到自动图）`, 'success');
    await loadItemThumbs();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    imgBusy.value = false;
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all([loadQueue(), loadMapped()]);
}

/**
 * 工具栏「刷新」：先清掉上一次的行级失败提示再重拉。
 *
 * ⚠️ 清 `failures` 的动作**不能**放进 `refreshAll()`：写入完成后是"先记失败、再重拉列表"，
 * 重拉顺手清空会把刚拿到的失败清单抹掉 —— 表现为"有行没写进去，界面却一声不响"。
 */
function manualRefresh(): void {
  failures.value = [];
  void refreshAll();
}

function gotoMapped(p: number): void {
  mPage.value = Math.min(Math.max(1, p), mappedPages.value);
  void loadMapped();
}

function showMore(): void {
  queueLimit.value = Math.min(QUEUE_MAX, queueLimit.value + QUEUE_STEP);
  void loadQueue();
}

function toggleQueueAll(e: Event): void {
  const next = new Set(selectedKeys.value);
  if ((e.target as HTMLInputElement).checked) selectableQueue.value.forEach((r) => next.add(queueKey(r)));
  else selectableQueue.value.forEach((r) => next.delete(queueKey(r)));
  selectedKeys.value = next;
}

function toggleQueueOne(r: SkuQueueRow): void {
  const next = new Set(selectedKeys.value);
  const k = queueKey(r);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  selectedKeys.value = next;
}

function clearSelection(): void {
  selectedKeys.value = new Set();
}

function openBatchPicker(): void {
  const target = selectedUnmapped.value;
  if (!target.length) return;
  picker.value = { mode: 'queue', queue: target };
}

function openRowPicker(r: SkuQueueRow): void {
  picker.value = { mode: 'queue', queue: [r] };
}

function openRebindPicker(r: ShopSkuRow): void {
  picker.value = { mode: 'rebind', row: r };
}

/** 弹层回传选中的产品 → 组出写入行 → **一次 op** 提交整批 */
async function applyPick(product: { id: number; color?: string }): Promise<void> {
  const target = picker.value;
  if (!target) return;
  busy.value = true;
  failures.value = [];
  try {
    // 颜色落在映射的 `spec` 上（D4）：空 = `'*'`（未指定），与一期行为等价
    const pickedColor = String(product.color ?? '').trim();
    const rows =
      target.mode === 'queue'
        ? target.queue.map((r) => ({
            platform: r.platform,
            shopId: r.shopId,
            itemId: r.itemId,
            spec: pickedColor || '*',
            productId: product.id,
            status: 'confirmed' as const,
          }))
        : [
            {
              platform: target.row.platform,
              shopId: target.row.shopId,
              itemId: target.row.itemId,
              // 改绑：选了新色就换，没选则**保留原色**（否则一次改绑把配好的颜色冲掉）
              spec: pickedColor || target.row.spec || '*',
              note: target.row.note,
              productId: product.id,
              // 改绑顺带把失效的映射拉回已确认 —— 用户点「改绑」就是想让它重新生效
              status: 'confirmed' as const,
            },
          ];

    const res = await api.skuMap({ rows });
    failures.value = res?.failed ?? [];
    picker.value = null;
    const created = res?.created ?? 0;
    const updated = res?.updated ?? 0;
    const reassigned = res?.reassigned ?? 0;
    const failed = failures.value.length;
    // 回填报出来 —— 否则"配完映射，订单页悄悄变了"是查不出的（人不知道归款是写时触发的）
    const tail = reassigned ? `，已自动关联 ${reassigned} 行存量订单` : '';
    const head = `新增 ${created} 条、更新 ${updated} 条${pickedColor ? `（颜色「${pickedColor}」）` : ''}${tail}`;
    if (failed) toast(`${head}，${failed} 条失败`, 'error');
    else toast(head, 'success');
    await refreshAll();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
    picker.value = null;
  } finally {
    busy.value = false;
  }
}

async function confirmInvalidate(): Promise<void> {
  const row = pendingInvalidate.value;
  if (!row) return;
  busy.value = true;
  failures.value = [];
  try {
    const res = await api.skuInvalidate(row.id);
    if (res?.changed) toast(`已标记「${row.itemId}」为失效`, 'success');
    else toast('这条映射已经不在了，列表已刷新', 'error');
    pendingInvalidate.value = null;
    await refreshAll();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/** 恢复：把失效的行重新标回已确认（商品ID 改回来 / 误标失效时用） */
async function restore(r: ShopSkuRow): Promise<void> {
  busy.value = true;
  failures.value = [];
  try {
    const res = await api.skuMap({
      rows: [
        {
          platform: r.platform,
          shopId: r.shopId,
          itemId: r.itemId,
          spec: r.spec,
          note: r.note,
          productId: r.productId,
          status: 'confirmed',
        },
      ],
    });
    failures.value = res?.failed ?? [];
    if (failures.value.length) toast('恢复失败', 'error');
    else toast(`已恢复「${r.itemId}」`, 'success');
    await refreshAll();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

onMounted(() => void refreshAll());
</script>

<style scoped>
.gd-map {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gd-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.gd-toolbar--sub {
  gap: 8px;
}
.gd-toolbar__search {
  width: 260px;
}
.gd-toolbar__select {
  width: auto;
  min-width: 140px;
}
.gd-toolbar__hint {
  font-size: 12px;
}
.gd-toolbar__actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

/* 分段控件样式已提到全局 `src/styles/index.css` 的 `@layer components`（.wb-seg*）——
   算钱页也要用同一套，按"控件样式只有一个来源"不再各写一份。 */

.gd-hints {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}
.gd-hints :deep(p) {
  margin: 0;
}

.gd-panel {
  flex: 1;
  min-height: 180px;
}
.gd-panel__empty {
  padding: 0;
}
.gd-c-check {
  width: 34px;
}
.gd-c-img {
  width: 56px;
}
.gd-c-ops {
  width: 128px;
  white-space: nowrap;
}
.gd-nowrap {
  white-space: nowrap;
}
.gd-note {
  margin-left: 6px;
  font-size: 12px;
  color: var(--wb-text-muted);
}
.gd-failures ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
tr.is-blocked :deep(td) {
  background: var(--wb-surface-2);
}
/* 商品ID图下的小操作（设图 / 换图 / 清除） */
.gd-imgops {
  display: flex;
  gap: 4px;
  margin-top: 2px;
}
.gd-imgops .wb-link {
  font-size: 11px;
  padding: 0 2px;
}
</style>
