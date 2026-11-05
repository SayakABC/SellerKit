<template>
  <!-- 「待发货」页签（2026-11-01 T2-4；2026-11-02 与「导入订单」合并）。
       这一屏回答两件**同一件事的两半**：
         ① 单从哪来 —— 主入口是芒果采集（打开芒果待发货页，扩展自动抓），Excel 是备选；
         ② 现在该先发哪几单 —— 按最晚发货时间排序，最急的在最上面。
       合并的理由（用户 2026-11-02）："两个页面合并，统一合并为待发货，弱化 Excel 导入按钮，
       以芒果采集为主"。原先两屏互相跳（清单说还有 7 单、但要发得先去另一屏导入/采集），
       用户第一眼不知道该站哪一屏。 -->
  <div class="wb-page q-view" data-act="queue-panel">
    <section class="wb-panel q-panel">
      <header class="wb-panel__head">
        <span>待发货</span>
        <!-- 口径小字：**跨天**。用户看到"12 单"时的第一个疑问是"这是今天导的还是全部的"，
             不写清就会与「总览」那块"今天要发"打架（两块本来就不是同一批，见 flowCtx）。 -->
        <span class="wb-muted q-scope" data-act="queue-scope">全部待发货 · 跨天 · 按最晚发货时间排</span>

        <!-- 主入口 = 芒果采集。它**常驻**（不只在空态出现）：清单再长，用户也可能刚在芒果那边
             改了状态、想立刻抓一次回来。 -->
        <div class="q-acts">
          <button
            class="wb-btn wb-btn--primary wb-btn--sm"
            type="button"
            data-act="queue-collect"
            title="打开芒果店长的待发货页面，扩展会自动抓一次"
            @click="onOpenMango"
          >
            去芒果采集
          </button>
          <!-- Excel 导入 = **备选**：视觉上退成 ghost 小按钮，并且内容默认收起。
               它没有消失（芒果登录过期 / 只有平台报表时仍需要它），但不再与采集抢主次。 -->
          <button
            class="wb-btn wb-btn--sm wb-btn--ghost"
            type="button"
            data-act="queue-excel-toggle"
            :aria-expanded="excelOpen"
            @click="excelOpen = !excelOpen"
          >
            {{ excelOpen ? '收起 Excel 导入' : 'Excel 导入（备选）' }}
          </button>
        </div>
      </header>

      <!-- 采集状态条：这一屏的主入口是采集，所以同步是否成功必须**就地说清**。
           文案与配色来自 `@/lib/syncBanner`（纯函数，四种形态有单测）—— 与总览那条同一份实现，
           不同屏只说不同的话会让同一个 0 有两种解释。 -->
      <p class="q-sync" :class="syncTone" data-act="queue-sync">
        <span class="q-sync__dot" aria-hidden="true"></span>
        <span data-act="queue-sync-text">{{ syncText }}</span>
        <span v-if="banner.partial" class="q-sync__tag" data-act="queue-sync-partial">
          抓取被截断
        </span>
      </p>

      <!-- 空态：**必须区分"还没同步"与"真没单"**（T2-5）。两句话指向两个完全不同的动作，
           而它们的界面长得一模一样 —— 混成一句"暂无数据"，用户只能靠猜。
           判据与总览那块共用 `isNeverSynced`（同一个 0 不许在两屏上说两种话）。 -->
      <div v-if="!q.orders" class="q-empty" data-act="queue-empty">
        <p class="q-empty__main">
          <template v-if="neverSynced">
            还没同步过 —— 打开芒果店长的待发货页面，扩展会自动抓一次
          </template>
          <template v-else>芒果那边待发货是空的（确实没有要发的单）</template>
        </p>
        <button
          v-if="neverSynced"
          class="wb-btn wb-btn--primary q-empty__cta"
          data-act="queue-open-mango"
          @click="onOpenMango"
        >
          打开芒果待发货页面
        </button>
        <p v-else class="q-empty__hint">
          若芒果上明明有单，看上面那条采集状态：登录过期 / 扩展没生效 / 抓取被截断都会在那里说
        </p>
      </div>

      <template v-else>
        <!-- 汇总一行：**单**与**行**分开写。一单三行时"3 单"和"3 行"必须一眼分得开，
             否则用户会以为"这单只发一件"，或者反过来以为"一共 9 单"。 -->
        <p class="q-sum" data-act="queue-sum">
          共 <b>{{ q.orders }}</b> 单 · {{ q.lines.length }} 行 · {{ q.pieces }} 件，其中
          <b :class="{ 'is-warn': q.risk > 0 }">{{ q.risk }}</b> 单 24 小时内到截止
        </p>
        <!-- 「算不出来」必须说出来：不说明的话「24 小时内 0 单」会被读成"都不着急"，
             而那几单恰恰是唯一连倒计时都没有的。 -->
        <p v-if="q.noDeadline" class="q-hint" data-act="queue-nodeadline">
          另有 {{ q.noDeadline }} 单没有截止期（导入单没有这一列），算不出会不会超时 —— 它们排在清单最后
        </p>

        <div class="wb-table-wrap q-wrap">
          <table class="wb-table" data-act="queue-table">
            <thead>
              <tr>
                <th class="q-img-col">图</th>
                <th>订单号</th>
                <th>店铺</th>
                <th>图案</th>
                <th class="wb-num">件数</th>
                <th>剩余时间</th>
                <th>图案状态</th>
              </tr>
            </thead>
            <!-- ⚠️ key 用下标：这一屏是**纯只读快照**（每次刷新整份重算），没有行内编辑，
                 所以下标做 key 不会出现"编辑态串行"那类问题。等这一列真能点开改东西时，
                 要换成订单行 id（那时 `PulseRow` 得带上 id）。 -->
            <tbody>
              <tr
                v-for="(l, i) in q.lines"
                :key="i"
                :class="{ 'is-overdue': l.overdue, 'is-risk': !l.overdue && l.risk, 'is-link': true }"
                data-act="queue-row"
                @click="openDetail(l)"
              >
                <!-- 缩略图（2026-11-05）：这一屏是"能不能发"的判断屏，而 POD 卖家判断的第一依据是图 ——
                     原来一个字都不给（备注说"每行一次读图 IPC 太重"），现在走**合批**通道
                     （`orderImageThumbBatch`，主进程一次最多 40 张、按路径去重）。
                     32px 只为"认出来是哪张"，看清印花仍要点开（弹层读原图）。 -->
                <td class="q-img-col">
                  <img
                    v-if="thumbOf(l)"
                    class="q-thumb"
                    :src="thumbOf(l)"
                    :alt="`${l.orderNo} 的行图`"
                    data-act="queue-thumb"
                  />
                  <span v-else class="q-thumb q-thumb--empty" title="这一单没有行图"></span>
                </td>
                <td class="q-no" data-act="queue-no">{{ l.orderNo || '（无单号）' }}</td>
                <td class="q-shop">{{ l.shop || '未登记' }}</td>
                <td class="q-style">
                  <template v-if="l.styleCode || l.styleColor">
                    {{ [l.styleCode, l.styleColor].filter(Boolean).join(' · ') }}
                  </template>
                  <span v-else class="q-unknown">未归类</span>
                </td>
                <td class="wb-num">
                  {{ l.pieces }}<span v-if="l.assumedQty" class="q-tilde" title="这行不知道数量，按 1 件计">?</span>
                </td>
                <!-- 剩余时间：title 里放**原文**，这样"是不是读对了列"用户自己能核
                     （D-2 定的是 `deal_deadline`，不是芒果那个早 6 天的 `qualifiedTime`）。 -->
                <td
                  class="q-remain"
                  :class="{ 'is-overdue': l.overdue, 'is-risk': !l.overdue && l.risk, 'is-unknown': !l.deadlineMs }"
                  :title="l.deadlineRaw ? `最晚发货：${l.deadlineRaw}` : '这单没有截止期（导入单没有这一列）'"
                  data-act="queue-remain"
                >
                  {{ remainText(l.remainMs) }}
                </td>
                <td>
                  <span class="q-chip" :class="`is-${l.pattern}`" data-act="queue-pattern">
                    {{ PATTERN_STATE_LABEL[l.pattern] }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>

    <!-- 单行详情（2026-11-05）—— 这一屏原来**点不动**：能看出"缺图 / 待绑"，
         却既看不到大图、也没法走到能改它的那一页。抽屉只做三件事：
         看图 / 说清这一单的事实（件数按 1 兜底的、没有截止期的都要写出来）/ 带单号去归类核对。
         ⚠️ 不在这里做写操作：发货状态与归类都各有唯一的写入口（平台回传 / 归类页保存）。 -->
    <div v-if="detail" class="wb-mask" data-act="queue-detail" @click.self="closeDetail">
      <div class="wb-dialog q-detail" role="dialog" aria-modal="true" aria-label="订单详情">
        <div class="wb-dialog__head">
          <span class="wb-mono" data-act="queue-detail-no">{{ detail.orderNo || '（无单号）' }}</span>
          <span class="wb-muted">{{ detail.shop || '未登记店铺' }}</span>
        </div>
        <div class="wb-dialog__body q-detail__body">
          <div class="q-detail__imgwrap">
            <img v-if="detailImg" :src="detailImg" class="q-detail__img" alt="" data-act="queue-detail-img" />
            <p v-else class="q-detail__ph">
              这一单没有行图 —— 采集没抓到图时，回芒果页面重抓一次通常就有了
            </p>
          </div>
          <dl class="q-detail__kv">
            <div>
              <dt>款 / 色</dt>
              <dd data-act="queue-detail-style">
                {{ [detail.styleCode, detail.styleColor].filter(Boolean).join(' · ') || '未归类' }}
              </dd>
            </div>
            <div>
              <dt>件数</dt>
              <dd>{{ detail.pieces }}{{ detail.assumedQty ? '（不知道数量，按 1 件计）' : '' }}</dd>
            </div>
            <div>
              <dt>最晚发货</dt>
              <dd class="wb-mono">{{ detail.deadlineRaw || '导入单没有这一列' }}</dd>
            </div>
            <div>
              <dt>剩余时间</dt>
              <dd>{{ remainText(detail.remainMs) }}</dd>
            </div>
            <div>
              <dt>图案状态</dt>
              <dd>{{ PATTERN_STATE_LABEL[detail.pattern] }}</dd>
            </div>
          </dl>
        </div>
        <div class="wb-dialog__foot">
          <button class="wb-btn" type="button" data-act="queue-detail-close" @click="closeDetail">
            关闭
          </button>
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            data-act="queue-detail-classify"
            @click="goClassify"
          >
            {{ detail.pattern === 'ready' ? '去归类核对查看这一单' : '去归类核对改这一单' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Excel 备选区（弱化）：默认收起；点页头的 ghost 按钮展开。
         两种情况下**自动展开**：① 导入进行中（否则用户看不到"正在识别"）；② 回执出现
         （否则导完的结论被折叠在看不见的地方，等于没反馈）。 -->
    <div v-show="excelOpen" class="q-excel" data-act="queue-excel">
      <ExcelImportSection />
    </div>
  </div>
</template>

<script setup lang="ts">
// 「待发货」页签（2026-11-01 T2-4；2026-11-02 合并「导入订单」）。
//
// 位置：挂在「总览」右边，带第 1 步编号（订单进来的入口）。
//
// 合并后的分工（**口径唯一**）：
//   · 订单来源：主 = 芒果采集（`openMangoPending`），备 = Excel 导入（`ExcelImportSection`）；
//   · 清单：行源由容器注入（`flowCtx.pulseRows`），本面板**不另取一次数** ——
//     否则会出现"总览说 3 单待发货、清单列 2 行"。
//
// 三个刻意的取舍（沿用 T2-4）：
//   ① **只读**。这一屏不做"标记已发货"之类的写操作：发货动作在芒果/平台那边完成，
//      这里自己造一份"已发"状态，第二天同步一回来就会与真相打架，用户还得解释哪个算数。
//   ② **不按单聚合**。一单三行就出三行 —— 件数与图案状态都是**行级**的，聚合成一行会让
//      "这单要印哪三个图案"彻底看不见，而那是 POD 卖家唯一真正关心的事。
//   ③ **缩略图不在这里**。每行一次读图 IPC，一屏 50 行就是 50 次；而且看图绑图案是
//      图案绑定台（M3）的活。这一屏的"图案"列只写款色，图由绑定台给。
//
// 算法一律在 `@/lib/shippingPulse`（纯函数，vitest 覆盖）：`shippingQueue` 排序 + `remainText` 分档
// + `patternStateOf` 三档。清单本身**一个 ipc 都不调**，行源由容器注入（见 `flowCtx.pulseRows`）。
import { computed, ref, watch } from 'vue';
import * as ipc from '@/core/services/ipc';
import { PATTERN_STATE_LABEL, remainText, shippingQueue, type QueueLine } from '@/lib/shippingPulse';
import { isNeverSynced, syncBanner } from '@/lib/syncBanner';
import { openMangoPending } from '../mangoOpen';
import { useShipping } from '../flowCtx';
import ExcelImportSection from './ExcelImportSection.vue';

const { pulseRows, token, summary, receipt, importing, classifyFocus, go } = useShipping();

/**
 * 「现在」——用 ref 而不是在 computed 里直接 `Date.now()`。
 *
 * 原因：`Date.now()` 不是响应式的，computed 只在行源变化时重算。用户点「刷新」若恰好
 * 没有新行进来（最常见的早上一开机就点一下），「还剩 3 小时」会停在**上次**算的值上 ——
 * 一条永远不减的倒计时，比没有倒计时更误导。所以刷新（`token` 变）时同步推进这个值。
 */
const now = ref(Date.now());
watch(
  () => token.value,
  () => {
    now.value = Date.now();
  },
);

/** 清单（排序 + 三档图案状态 + 剩余时间，全部在纯函数里） */
const q = computed(() => shippingQueue(pulseRows.value, { now: now.value }));

// ---- 缩略图（2026-11-05）----------------------------------------------------------------
//
// 为什么在面板里读、而不在 `shippingQueue` 里读：那是纯函数（vitest 直接调），
// 里面出现 IPC 就没法测了。面板只负责"把这些路径批量换成 dataURL"。
//
// ⚠️ 合批是**必须**的：一屏 50 行就 50 次往返，主进程一次最多 40 张 ——
//    `orderImageThumbBatch` 内部已按 40 拆批，这里只要把路径去重后交给它。
// ⚠️ 失败静默：图读不出来不影响"还剩几小时"这条主线，留空占位即可（点开详情会说明）。
const thumbs = ref<Record<string, string>>({});
watch(
  () => q.value.lines.map((l) => l.localPath).join('|'),
  () => {
    void loadThumbs();
  },
  { immediate: true },
);

async function loadThumbs(): Promise<void> {
  const paths = [...new Set(q.value.lines.map((l) => l.localPath).filter(Boolean))];
  if (!paths.length) {
    thumbs.value = {};
    return;
  }
  const r = await ipc.orderImageThumbBatch(paths.map((localPath) => ({ localPath, maxEdge: 64 })));
  if (!r.success) return;
  const next: Record<string, string> = {};
  paths.forEach((p, i) => {
    const url = r.data?.dataUrls?.[i];
    if (url) next[p] = url;
  });
  thumbs.value = next;
}

/** 某一行的小图（没有路径 / 还没读回来 ⇒ 空串，模板出占位） */
function thumbOf(l: QueueLine): string {
  return l.localPath ? thumbs.value[l.localPath] ?? '' : '';
}

// ---- 单行详情（2026-11-05）--------------------------------------------------------------
//
// 三件事：看图 / 说清这一单的事实 / 带单号去「归类核对」。
// ⚠️ `detailSeq` 与归类页的 `viewerSeq` 同一条理由：连点两行时，晚到的原图不许盖到后点的那一行。
const detail = ref<QueueLine | null>(null);
const detailImg = ref('');
let detailSeq = 0;

async function openDetail(l: QueueLine): Promise<void> {
  detail.value = l;
  // 先用**手里已有的**缩略图把弹层开出来（点下去立刻有东西看，不等磁盘）
  detailImg.value = thumbOf(l);
  const path = l.localPath;
  if (!path) return;
  const seq = ++detailSeq;
  const r = await ipc.orderReadImage(path);
  if (seq !== detailSeq || !r.success || !r.data?.dataUrl) return;
  detailImg.value = r.data.dataUrl;
}

function closeDetail(): void {
  detail.value = null;
  detailImg.value = '';
  detailSeq += 1; // 让还在飞的原图失效
}

/**
 * 带着单号去第 2 步（2026-11-05）。
 * 只传**单号**：归类页的搜索口径就是单号/店铺/款色文本，传行 id 会变成第二条匹配规则。
 */
function goClassify(): void {
  const no = detail.value?.orderNo ?? '';
  closeDetail();
  if (no) classifyFocus.value = no;
  go('classify');
}

/** 采集状态条（文案/配色唯一实现在 `@/lib/syncBanner`） */
const banner = computed(() => syncBanner(summary.value.sync));
const syncText = computed(() => banner.value.text);
const syncTone = computed(() => `is-${banner.value.tone}`);

/** 从没同步过：空态要指向"去采集"，而不是说"没单"（两件事的下一步完全不同） */
const neverSynced = computed(() => isNeverSynced(summary.value.sync));

/**
 * Excel 备选区是否展开（默认收起 = "弱化"的具体做法）。
 *
 * ⚠️ 导入进行中 / 回执出现时**自动展开**：入口在折叠区里，但**反馈不能也被折叠** ——
 *    否则用户导完只看到按钮恢复，结论与"下一步"全在看不见的地方。
 */
const excelOpen = ref(false);
watch(importing, (v) => {
  if (v) excelOpen.value = true;
});
watch(
  () => receipt.value,
  (r) => {
    if (r) excelOpen.value = true;
  },
);

/** 主入口：打开芒果待发货页（失败自己 toast，见 `mangoOpen`） */
function onOpenMango(): void {
  void openMangoPending();
}
</script>

<style scoped>
/* 面板吃满高度，滚动只发生在表格容器上（页头与汇总行固定） —— 与「归类核对」同一套 */
.q-view {
  gap: 12px;
}

.q-panel {
  flex: 1 1 auto;
  min-height: 240px;
}

/* 页头空间有限：标题 / 口径 / 动作一行放下，窄窗时动作换行靠右 */
.q-scope {
  font-size: 12px;
  font-weight: 400;
  color: var(--wb-text-muted);
}

.q-acts {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-left: auto;
}

/* 采集状态条：比总览那条更轻（它已在页头里，不与数字抢），但失败时整条染色 */
.q-sync {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  flex-shrink: 0;
  margin: 0 14px;
  padding: 5px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-text-muted);
}

.q-sync__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.75;
}

.q-sync.is-ok .q-sync__dot {
  background: var(--wb-success);
  opacity: 1;
}

.q-sync.is-idle .q-sync__dot {
  background: var(--wb-warning);
  opacity: 1;
}

.q-sync.is-warn {
  color: var(--wb-warning);
}

.q-sync.is-error {
  color: var(--wb-danger);
}

.q-sync__tag {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 11px;
  line-height: 16px;
}

.q-sum {
  margin: 0;
  padding: 10px 14px 0;
  font-size: 13px;
  color: var(--wb-text);
  flex-shrink: 0;
}

.q-sum b {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.q-sum b.is-warn {
  color: var(--wb-warning);
}

/* 「算不出风险」那句：虚线左边框（与总览同一套语言），别做成红色 —— 它是声明不是错误 */
.q-hint {
  margin: 4px 14px 0;
  padding-left: 8px;
  border-left: 2px dashed var(--wb-border);
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-text-muted);
  flex-shrink: 0;
}

/* 表格容器：唯一滚动区（`.wb-panel` 是 overflow:hidden，不套这层会被**静默裁掉**右半截） */
.q-wrap {
  flex: 1;
  min-height: 0;
  margin-top: 10px;
  border-top: 1px solid var(--wb-border);
}

.q-no {
  font-variant-numeric: tabular-nums;
}

/* 未登记店铺 / 未归类款色：弱一档但**不能留空**（空白会让人以为"这行没这一项"，
   而实际是"这一项还不知道" —— 两者要做的事不同） */
.q-shop,
.q-style .q-unknown {
  color: var(--wb-text-muted);
}

.q-unknown {
  font-style: normal;
}

/* 件数按 1 兜底的标记：小、灰、带上 title —— 不许让它看起来像个确定的数 */
.q-tilde {
  margin-left: 2px;
  font-size: 11px;
  color: var(--wb-text-muted);
}

.q-remain {
  font-variant-numeric: tabular-nums;
}

/* 已超时：**红的**（这一单已经在赔钱路上）；快超时：黄的。
   用整行浅底 + 左侧竖条而不是只染文字 —— "越紧急越靠上"这件事要能被扫视确认，
   只染一个字的话，一屏 50 行扫下来根本分不出哪几行是红的。 */
.q-remain.is-overdue {
  color: var(--wb-danger);
  font-weight: 600;
}

.q-remain.is-risk {
  color: var(--wb-warning);
  font-weight: 600;
}

/* 没有截止期：弱化但写「不知道」，不用破折号（破折号会被读成"没有这个字段所以不重要"） */
.q-remain.is-unknown {
  color: var(--wb-text-muted);
}

tbody tr.is-overdue td:first-child {
  box-shadow: inset 2px 0 0 var(--wb-danger);
}

tbody tr.is-risk td:first-child {
  box-shadow: inset 2px 0 0 var(--wb-warning);
}

/* 图案状态：三档三种语义色。缺图是**要动手找买家/补图**的一档，用警示色；
   待绑是"还差归类"，用弱化的中性色；已绑不染色（它是常态，常态不该有颜色）。 */
.q-chip {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--wb-border);
  font-size: 11.5px;
  line-height: 17px;
  white-space: nowrap;
}

.q-chip.is-ready {
  color: var(--wb-text-muted);
  background: var(--wb-surface-2);
}

.q-chip.is-unbound {
  color: var(--wb-warning);
  border-color: color-mix(in srgb, var(--wb-warning) 45%, transparent);
}

.q-chip.is-noImage {
  color: var(--wb-danger);
  border-color: color-mix(in srgb, var(--wb-danger) 45%, transparent);
}

/* 空态：一句话说清"没有单"是哪种没有 + 一句排查指向（不铺满，靠上对齐） */
.q-empty {
  padding: 24px 20px 28px;
}

.q-empty__main {
  margin: 0 0 8px;
  font-size: 15px;
  color: var(--wb-text);
}

.q-empty__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}

/* 入口按钮跟内容宽度，不铺满整行 */
.q-empty__cta {
  align-self: flex-start;
  margin-top: 2px;
}

/* Excel 备选区：独立一块（不套 .wb-panel —— 它自己是几个小块的组合，套两层卡会显得比主入口还重） */
.q-excel {
  flex-shrink: 0;
  padding: 12px 14px 14px;
  border: 1px dashed var(--wb-border-strong);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
}

/* ---- 缩略图列（2026-11-05） -------------------------------------------------
   32px 只为"认得出是哪张"（列宽 44px 含 padding）；看清印花走详情弹层读原图。
   `object-fit: cover` 在这里是对的：方框只承担"这张图长什么样"的整体印象，
   竖版图被裁边不影响判断（要完整形状请点开）。 */
.q-img-col {
  width: 44px;
}

.q-thumb {
  display: block;
  width: 32px;
  height: 32px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  object-fit: cover;
}

/* 没图：留一个虚线空框 —— 空白会让人以为"这一列没加载出来"，
   虚线框说的是"这一行确实没有图"（与列表里「缺图」chip 指向同一件事）。 */
.q-thumb--empty {
  border: 1px dashed var(--wb-border-strong);
}

/* 整行可点（打开详情）：指针 + hover 底色，让"能点"这件事在点之前就成立 */
tbody tr.is-link {
  cursor: pointer;
}

tbody tr.is-link:hover {
  background: var(--wb-hover);
}

/* ---- 单行详情 ------------------------------------------------------------ */
.q-detail {
  width: min(600px, 92vw);
}

.q-detail__body {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.q-detail__imgwrap {
  flex: 0 0 180px;
  width: 180px;
}

.q-detail__img {
  width: 100%;
  max-height: 260px;
  border-radius: var(--wb-radius);
  background: var(--wb-surface-2);
  object-fit: contain;
}

.q-detail__ph {
  margin: 0;
  padding: 12px;
  border: 1px dashed var(--wb-border-strong);
  border-radius: var(--wb-radius);
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}

.q-detail__kv {
  margin: 0;
  display: grid;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.q-detail__kv div {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 8px;
  align-items: baseline;
}

.q-detail__kv dt {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.q-detail__kv dd {
  margin: 0;
  font-size: 13px;
  color: var(--wb-text);
  word-break: break-all;
}
</style>
