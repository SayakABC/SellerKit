<template>
  <!-- 「待发货清单」页签（2026-11-01 T2-4）。
       这一屏只回答一件事：**今天该先发哪几单**。所以第一件事是按最晚发货时间排序 ——
       最急的在最上面，用户从上往下发，发到哪算到哪，不必自己比较 12 个时间戳。 -->
  <div class="wb-page q-view" data-act="queue-panel">
    <section class="wb-panel q-panel">
      <header class="wb-panel__head">
        <span>待发货清单</span>
        <!-- 口径小字：**跨天**。用户看到"12 单"时的第一个疑问是"这是今天导的还是全部的"，
             不写清就会与「总览」那块"今天要发"打架（两块本来就不是同一批，见 flowCtx）。 -->
        <span class="wb-muted" data-act="queue-scope">全部待发货 · 跨天 · 按最晚发货时间排</span>
      </header>

      <!-- 空态：**必须区分"还没同步"与"真没单"**（T2-3 状态条治的就是这个歧义，
           这里不能自己再犯一次）。两句话指向两个完全不同的动作。 -->
      <div v-if="!q.orders" class="q-empty" data-act="queue-empty">
        <p class="q-empty__main">
          <template v-if="neverSynced">还没同步过 —— 去芒果的待发货页面点一下采集，这里就会有单</template>
          <template v-else>当前没有待发货订单（芒果那边待发货列表是空的）</template>
        </p>
        <p class="q-empty__hint">
          如果芒果上明明有单，看页面顶部的采集状态条：登录过期 / 扩展没生效 / 抓取被截断都会在那里说
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
                :class="{ 'is-overdue': l.overdue, 'is-risk': !l.overdue && l.risk }"
                data-act="queue-row"
              >
                <td class="q-no">{{ l.orderNo || '（无单号）' }}</td>
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
  </div>
</template>

<script setup lang="ts">
// 「待发货」页签（2026-11-01 T2-4）。
//
// 位置：挂在「总览」右边、四步之前。**它不是某一步** —— 四步讲的是"今天导进来的这批怎么走完"，
// 这一屏讲的是"现在手上还有几单没发"（跨天）。所以它没有步骤号，也不参与「当前步」评选。
//
// 三个刻意的取舍：
//   ① **只读**。这一屏不做"标记已发货"之类的写操作：发货动作在芒果/平台那边完成，
//      这里自己造一份"已发"状态，第二天同步一回来就会与真相打架，用户还得解释哪个算数。
//   ② **不按单聚合**。一单三行就出三行 —— 件数与图案状态都是**行级**的，聚合成一行会让
//      "这单要印哪三个图案"彻底看不见，而那是 POD 卖家唯一真正关心的事。
//   ③ **缩略图不在这里**。每行一次读图 IPC，一屏 50 行就是 50 次；而且看图绑图案是
//      图案绑定台（M3）的活。这一屏的"图案"列只写款色，图由绑定台给。
//
// 算法一律在 `@/lib/shippingPulse`（纯函数，vitest 覆盖）：`shippingQueue` 排序 + `remainText` 分档
// + `patternStateOf` 三档。本面板**一个 ipc 都不调**，行源由容器注入（见 `flowCtx.pulseRows`）。
import { computed, ref, watch } from 'vue';
import { PATTERN_STATE_LABEL, remainText, shippingQueue } from '@/lib/shippingPulse';
import { useShipping } from '../flowCtx';

const { pulseRows, token, summary } = useShipping();

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

/** 从没同步过：空态要指向"去采集"，而不是说"没单"（两件事的下一步完全不同） */
const neverSynced = computed(() => {
  const s = summary.value.sync;
  // 读不到日志时不能说"还没同步过"（那会把"日志表坏了"说成"你今天还没开始"）
  return !s.error && s.last === null;
});
</script>

<style scoped>
/* 面板吃满高度，滚动只发生在表格容器上（页头与汇总行固定） —— 与「归类核对」同一套 */
.q-view {
  gap: 12px;
}

.q-panel {
  flex: 1;
  min-height: 0;
}

/* 页头那句口径小字：比标题弱一档，但**不能省** —— 它交代了"跨天"这个最容易被误读的范围 */
.wb-panel__head .wb-muted {
  font-size: 12px;
  font-weight: 400;
  color: var(--wb-text-muted);
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
  padding: 28px 20px;
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
</style>
