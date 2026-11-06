<template>
  <!-- 「订单」屏（2026-11-05；由「总览」+「待发货」合并，用户拍板 D-1）。
       它回答**两个层次**的同一个问题：
         ① 我这批单现在是什么处境 —— 状态分组四个数（缺图 / 待归类 / 待拿货 / 已备齐）；
         ② 具体是哪几单、每一单卡在哪 —— 一单一行，按最晚发货时间排，可展开到明细行。
       为什么合并：原来「总览」是聚合、「待发货」是明细，两屏回答同一个问题却要用户自己对照；
       更糟的是「总览」那个「按此开始发货」按钮落到一个**只读清单**上（那一屏明写不做任何写操作）
       —— 按钮承诺了它做不到的事，这是"看不明白"的第一根因。
       ⚠️ 这一屏**仍然只读**：发货在芒果点（`ship_time` 至今没有回写路径，见 docs/notes）。
          所有"动作"都是**带上下文去另一个页签**，或打开芒果页面，绝不本地造状态。 -->
  <div class="wb-page od-view" data-act="order-panel">
    <section class="wb-panel od-panel">
      <header class="wb-panel__head">
        <span>订单</span>
        <!-- 口径小字：**平台待发货 + 跨天**。用户看到"12 单"时的第一个疑问是"这是今天导的还是全部的"；
             后半句（已在平台发货的单不在这里）同时解释了"为什么我发过的单还看得见/看不见"。 -->
        <span class="wb-muted od-scope" data-act="order-scope">
          平台待发货 · 跨天 · 按最晚发货时间排
        </span>

        <!-- 主入口 = 芒果采集（常驻：清单再长，用户也可能刚在芒果那边改了状态想立刻抓一次）。
             刻意**不是实心主按钮**了：首屏唯一的焦点现在是「开始处理」（跟着它服务的数字走）。 -->
        <div class="od-acts">
          <button
            class="wb-btn wb-btn--sm"
            type="button"
            data-act="order-collect"
            title="打开芒果店长的待发货页面，扩展会自动抓一次"
            @click="onOpenMango"
          >
            去芒果采集
          </button>
          <!-- Excel 导入 = 备选：ghost 小按钮 + 内容默认收起（芒果登录过期 / 只有平台报表时才用） -->
          <button
            class="wb-btn wb-btn--sm wb-btn--ghost"
            type="button"
            data-act="order-excel-toggle"
            :aria-expanded="excelOpen"
            @click="excelOpen = !excelOpen"
          >
            {{ excelOpen ? '收起 Excel 导入' : 'Excel 导入（备选）' }}
          </button>
        </div>
      </header>

      <!-- 采集状态条：这一屏的主入口是采集，同步是否成功必须**就地说清**。
           文案与配色来自 `@/lib/syncBanner`（纯函数，四态有单测）—— 与以前两屏共用同一份实现，
           不同屏只说不同的话会让同一个 0 有两种解释。 -->
      <p class="od-sync" :class="syncTone" data-act="sync-bar">
        <span class="od-sync__dot" aria-hidden="true"></span>
        <span data-act="sync-text">{{ syncText }}</span>
        <span v-if="banner.partial" class="od-sync__tag" data-act="sync-partial">抓取被截断</span>
      </p>

      <!-- 「今天进来」= **口径说明**（一行，不是主角）。
           它服务的是"今天这批采集到没有"，与下面"现在要发几单"是**两个批次**：
           前者按导入日筛（服务归类核对），后者按当前状态算（跨天 —— 昨天没发完的今天还在）。
           两块合并成一屏之后仍然要分开写：并成一行会出现"待发货 0 但今天进来 12 单"这种自相矛盾的画面。
           ⚠️ 断言钉在 `data-act` 上（`stat-orders` 等），数字放在**各自的 b 标签**里 ——
              文案会改，锚点与"这一格是哪个数"不该跟着改。 -->
      <p class="od-brief" data-act="daily-summary">
        <template v-if="daily.orders">
          <span class="od-brief__label">今天进来</span>
          <b data-act="stat-orders">{{ daily.orders }}</b> 单 ·
          <b data-act="stat-pieces">{{ daily.pieces }}</b> 件商品 · 已拿
          <b data-act="stat-taken">{{ daily.taken }}</b> · 还差
          <b data-act="stat-remaining" :class="{ 'is-done': !daily.remaining }">{{
            daily.remaining
          }}</b>
          <span
            class="od-brief__bar"
            data-act="daily-bar"
            :title="`已拿 ${daily.taken} / 共 ${daily.pieces} 件`"
          >
            <span class="od-brief__fill" :style="{ width: percent + '%' }"></span>
          </span>
          <span class="od-brief__scope" data-act="daily-scope">
            今天导入的订单 · 不含已关闭/已完成
          </span>
        </template>
        <!-- 空态：这句话本身已经交代了范围（"今天"），所以不挂口径小字。
             ⚠️ 措辞是「今天还没有订单」而不是「还没有订单数据」：库里可能明明有前几天的单，
                说"没有数据"是假话（用户会以为数据丢了）。 -->
        <template v-else>
          <span class="od-brief__label" data-act="daily-empty">今天还没有订单</span>
          <span class="od-brief__hint">
            主入口：打开芒果店长的待发货页面，扩展会自动抓一次 · 备选：Excel 导入
          </span>
          <button
            class="wb-btn wb-btn--primary wb-btn--sm"
            type="button"
            data-act="empty-collect"
            @click="onOpenMango"
          >
            去芒果采集
          </button>
          <button
            class="wb-btn wb-btn--sm wb-btn--ghost"
            type="button"
            data-act="empty-import"
            :disabled="importing"
            @click="onEmptyImport"
          >
            {{ importing ? '导入中…' : 'Excel 导入（备选）' }}
          </button>
        </template>
      </p>
      <!-- 「已拿」里混进了"无归属台账"（加 `order_item_id` 之前的拿货单）⇒ 是推定，不是事实。
           必须说出来，否则用户会拿这个数当逐单结论（"这件明明拿了"）。 -->
      <p v-if="daily.estimated" class="od-hint" data-act="daily-estimated">
        已拿里有历史拿货单（没记订单归属），按款色总量估算
      </p>

      <!-- 状态分组 + 四数（这一屏的主结构）。
           分组不是"筛选项"而是**这一批单的处境分布**：点一下筛到该档，点第二下取消。
           ⚠️ 四档之和必须恒等于下面那句「合计 N 单」：同一个数、同一份来源（`orderStage.counts`），
              否则又会回到"总览说 3 单、清单列 2 行"。 -->
      <div class="od-stages" data-act="pulse-summary">
        <div class="od-stages__row">
          <button
            v-for="s in STAGES"
            :key="s"
            type="button"
            class="od-stage"
            :class="[`is-${s}`, { 'is-on': stage === s, 'is-zero': !counts[s] }]"
            :data-act="`stage-${s}`"
            :aria-pressed="stage === s"
            :title="stageTitle(s)"
            @click="pickStage(s)"
          >
            <b>{{ counts[s] }}</b>
            <span>{{ STAGE_LABEL[s] }}</span>
          </button>
          <!-- 首屏唯一实心按钮：从"最卡的一档"开始（缺图 → 待归类 → 待拿货 → 已备齐）。
               它做的事**只是筛一下清单**，不假装能发货 —— 这一屏没有那个能力（见文件头）。 -->
          <button
            class="wb-btn wb-btn--primary wb-btn--sm od-start"
            type="button"
            data-act="order-start"
            :disabled="!plan.orders.length"
            :title="startTitle"
            @click="startFromWorst"
          >
            开始处理
          </button>
        </div>

        <!-- 汇总一行：**单 / 件 / 风险 / 缺图行** 四个数平铺。
             它们与四档是不同量纲（档 = 单，缺图 = 行），所以分开写而不是塞进四格。 -->
        <p class="od-sum" data-act="order-sum">
          合计 <b data-act="stat-pending">{{ pulse.pending }}</b> 单待发货 ·
          <b data-act="stat-pulse-pieces">{{ pulse.pieces }}</b> 件 · 其中
          <b :class="{ 'is-warn': pulse.risk > 0 }" data-act="stat-risk">{{ pulse.risk }}</b>
          单 24 小时内到截止 ·
          <b data-act="stat-missing-image">{{ pulse.missingImage }}</b> 行缺图
        </p>
        <!-- 「算不出来」必须说出来：不说明的话「24 小时内 0 单」会被读成"都不着急"，
             而那几单恰恰是唯一连倒计时都没有的。 -->
        <p v-if="pulse.noDeadline" class="od-hint" data-act="pulse-nodeadline">
          另有 {{ pulse.noDeadline }} 单没有截止期（导入单没有这一列），算不出会不会超时 ——
          它们排在清单最后
        </p>
        <!-- 覆盖度读不到 / 有个别行 join 不上：这些单落「待核对」，**不许**默认已备齐。
             不写这一行的话，用户会把"判不出来"读成"都齐了"，当天少发一批货。 -->
        <p v-if="counts.unknown" class="od-hint od-hint--warn" data-act="stage-unknown-hint">
          有 {{ counts.unknown }} 单判不出货齐没齐（{{
            plan.coverageKnown ? '这几行没有订单行身份' : '这次没读到拿货记录'
          }}）—— 去拿货页按单核对一下，别当已备齐
        </p>
      </div>

      <!-- 空态：**必须区分"还没同步过"与"真没单"**（两种 0 要做的事完全不同，
           而它们的界面长得一模一样）。判据与以前两屏共用 `isNeverSynced`。 -->
      <div v-if="!plan.orders.length" class="od-empty" data-act="pulse-empty">
        <p class="od-empty__main">
          <template v-if="neverSynced">
            还没同步过 —— 打开芒果店长的待发货页面，扩展会自动抓一次
          </template>
          <template v-else>芒果那边待发货是空的（确实没有要发的单）</template>
        </p>
        <button
          v-if="neverSynced"
          class="wb-btn wb-btn--primary od-empty__cta"
          type="button"
          data-act="pulse-open-mango"
          @click="onOpenMango"
        >
          打开芒果待发货页面
        </button>
        <p v-else class="od-empty__hint">
          若芒果上明明有单，看上面那条采集状态：登录过期 / 扩展没生效 / 抓取被截断都会在那里说
        </p>
      </div>

      <!-- 筛出来是空档：说"这一档没有单"，别把整屏换成"没有订单"（那会让人以为单都没了） -->
      <p v-else-if="!visible.length" class="od-empty od-empty--filter" data-act="order-filter-empty">
        这一档没有单 —— 点上面同一格取消筛选
      </p>

      <div v-else class="od-list" data-act="order-list">
        <!-- 一行 = **一张订单**（不是一行商品）。
             ⚠️ 订单号是键：没有单号的行按行 id 归组（`orderStage` 已保证每单一个对象）。 -->
        <div
          v-for="(o, i) in visible"
          :key="o.orderNo || `r${i}`"
          class="od-row"
          :class="{ 'is-open': isOpen(o), 'is-risk': o.risk && !o.overdue, 'is-overdue': o.overdue }"
          data-act="order-row"
        >
          <div
            class="od-row__head"
            role="button"
            tabindex="0"
            data-act="order-row-head"
            :aria-expanded="isOpen(o)"
            @click="toggle(o)"
            @keydown.enter.prevent="toggle(o)"
            @keydown.space.prevent="toggle(o)"
          >
            <span class="od-row__chev" data-act="order-expand" aria-hidden="true">{{
              isOpen(o) ? '▾' : '▸'
            }}</span>
            <!-- 缩略图：这一屏是"能不能发"的判断屏，而 POD 卖家判断的第一依据是图。
                 合一单一行之后取**第一行明细的图**（一单多图时展开就都能看到）。 -->
            <img
              v-if="thumbOf(o)"
              class="od-thumb"
              :src="thumbOf(o)"
              :alt="`${o.orderNo} 的图`"
              data-act="order-thumb"
            />
            <span v-else class="od-thumb od-thumb--empty" data-act="order-thumb-empty"></span>

            <span class="od-row__no" data-act="order-no">{{ o.orderNo || '（无单号）' }}</span>
            <span class="od-row__shop">{{ o.shop || '未登记' }}</span>
            <span class="od-row__pieces">
              {{ o.pieces }} 件<template v-if="hasAssumed(o)">?</template>
            </span>
            <!-- 剩余时间：title 里放**原文**，这样"是不是读对了列"用户自己能核 -->
            <span
              class="od-row__remain"
              :class="{ 'is-risk': o.risk && !o.overdue, 'is-overdue': o.overdue, 'is-unknown': !o.deadlineMs }"
              :title="o.deadlineRaw ? `最晚发货：${o.deadlineRaw}` : '这单没有截止期（导入单没有这一列）'"
              data-act="order-remain"
            >
              {{ remainText(o.remainMs) }}
            </span>
            <span class="od-chip" :class="`is-${o.stage}`" data-act="order-stage">
              {{ STAGE_LABEL[o.stage] }}<template v-if="chipNote(o)"> · {{ chipNote(o) }}</template>
            </span>
            <!-- 每单一个主操作，**带上下文**：
                   缺图 → 回芒果重抓；待归类 → 带单号去归类；待拿货 → 带款色去拿货；
                   已备齐 → 复制单号 + 打开芒果发货页；待核对 → 去拿货页按单核对。 -->
            <button
              class="wb-btn wb-btn--sm od-row__act"
              :class="{ 'wb-btn--primary': o.stage === 'ready' }"
              type="button"
              :data-act="`order-act-${o.stage}`"
              :title="actTitle(o)"
              @click.stop="actOn(o)"
            >
              {{ ACTION_LABEL[o.stage] }}
            </button>
          </div>

          <!-- 展开 = 明细行。一单三行可能卡在三个不同的档（缺 1 张图 + 少 2 件货），
               只给订单级一个 chip 会把原因吞掉。 -->
          <div v-if="isOpen(o)" class="od-lines" data-act="order-lines">
            <div
              v-for="l in o.lines"
              :key="l.orderItemId || `${l.styleCode}-${l.size}`"
              class="od-line"
              data-act="order-line"
            >
              <span class="od-line__name">{{ [l.styleCode || '未识别款', l.color || '未分类', l.size || '—'].join(' · ') }}</span>
              <span class="od-line__qty">× {{ l.qty }}{{ l.assumedQty ? '?' : '' }}</span>
              <span class="od-line__cov">
                <template v-if="l.covered === null">已拿未知</template>
                <template v-else-if="l.gap">还差 {{ l.gap }} 件</template>
                <template v-else>已齐</template>
              </span>
              <span v-if="l.estimated" class="od-line__tag" title="这条里含无归属台账的推算">推算</span>
              <span class="od-chip od-chip--sm" :class="`is-${l.stage}`" data-act="order-line-stage">
                {{ STAGE_LABEL[l.stage] }}
              </span>
            </div>
            <div class="od-lines__foot">
              <!-- 单号是跨页唯一识别得出的东西（拿货页是款色级、归类页按单号搜），
                   所以这里两个出口都带着它，用户不必回去再抄一遍。 -->
              <button
                class="wb-btn wb-btn--sm"
                type="button"
                data-act="order-act-classify"
                @click.stop="gotoClassify(o)"
              >
                带单号去归类核对
              </button>
              <button
                v-if="o.stage === 'waitingStock' || o.stage === 'unknown'"
                class="wb-btn wb-btn--sm"
                type="button"
                data-act="order-act-purchase"
                @click.stop="gotoPurchase(o)"
              >
                带款色去拿货
              </button>
              <button
                v-if="o.stage === 'ready'"
                class="wb-btn wb-btn--sm"
                type="button"
                data-act="order-copy"
                @click.stop="copyNo(o)"
              >
                复制单号
              </button>
              <!-- 一单多行时把每行的图都摆出来：判断"能不能发"就看图，文字代替不了 -->
              <span class="od-lines__foot-hint">
                共 {{ o.pieces }} 件{{ o.gap ? `，还差 ${o.gap} 件` : '' }}{{ o.gapUnknown ? '（部分行缺口算不出）' : '' }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Excel 备选区（弱化）：默认收起；点页头 ghost 按钮展开。
         两种情况下**自动展开**：① 导入进行中；② 回执出现 —— 否则导完的结论被折叠在看不见的地方。 -->
    <div v-show="excelOpen" class="od-excel" data-act="order-excel">
      <ExcelImportSection />
    </div>
  </div>
</template>

<script setup lang="ts">
// 「订单」屏（2026-11-05，由「总览」+「待发货」合并）。
//
// 这一屏的结构只有三段：**采集状态 → 今天进来（口径）→ 状态分组 + 订单清单**。
//
// 五条刻意的取舍（都别再改回去）：
//   ① **只读**。不做"标记已发货"：发货动作在芒果完成，这里自己造一份"已发"状态，
//      第二天同步一回来就会与真相打架（`ship_time` 至今没有回写路径，界面上要说清）。
//   ② **一单一行**（以前是一行一个商品行）。订单是用户脑子里的单位（"这单能发了吗"），
//      商品行是他的下钻 —— 所以行级细节放展开区，不压平到主列表。
//   ③ **状态是派生的**，全部来自 `@/lib/orderStage`（纯函数，vitest 覆盖）。
//      本组件一个判定都不算：它只摆放 + 派发动作。
//   ④ **一个动作只做一件事**，且带上下文（单号 / 款色）。把"去拿货"做成纯切页签 =
//      用户到了那片宫格里还得自己找那一款色。
//   ⑤ 四档计数之和 === 「合计 N 单待发货」。这是这一屏唯一能自证的恒等式。
import { computed, ref, watch } from 'vue';
import * as ipc from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import { writeClipboard } from '@/core/services/clipboard';
import {
  ORDER_STAGE_ACTION,
  ORDER_STAGE_LABEL,
  ORDER_STAGE_ORDER,
  orderStages,
  type OrderStage,
  type OrderStageOrder,
} from '@/lib/orderStage';
import { remainText } from '@/lib/shippingPulse';
import { isNeverSynced, syncBanner } from '@/lib/syncBanner';
import { openMangoPending } from '../mangoOpen';
import { useShipping } from '../flowCtx';
import ExcelImportSection from './ExcelImportSection.vue';

const {
  pulseRows,
  summary,
  coverage,
  token,
  receipt,
  importing,
  importExcel,
  classifyFocus,
  purchaseFocus,
  go,
} = useShipping();

/** 界面词与动作词的唯一来源（lib 里），本组件只做别名，不写第二份文案 */
const STAGE_LABEL = ORDER_STAGE_LABEL;
const ACTION_LABEL = ORDER_STAGE_ACTION;
const STAGES = ORDER_STAGE_ORDER;

/**
 * 「现在」——用 ref 而不是在 computed 里直接 `Date.now()`。
 *
 * 原因：`Date.now()` 不是响应式的，computed 只在行源变化时重算。用户点「刷新」若恰好
 * 没有新行进来（最常见的早上开机就点一下），「还剩 3 小时」会停在**上次**算的值上 ——
 * 一条永远不减的倒计时，比没有倒计时更误导。所以刷新（`token` 变）时同步推进这个值。
 */
const now = ref(Date.now());
watch(
  () => token.value,
  () => {
    now.value = Date.now();
  }
);

/**
 * 整份「订单 → 档位」。**本屏唯一的判定入口**（`orderStages` 内部复用
 * `shippingQueue` / `planCoverage` / `patternStateOf`，不重写任何判据）。
 *
 * ⚠️ `coverage.value.ok === false` ⇒ 全部落「待核对」：不许把"这次没读到拿货记录"
 *    折成"一件没拿"（会让用户重复下单）或"已经齐了"（会少发一批货）。
 */
const plan = computed(() =>
  orderStages(pulseRows.value, {
    covered: coverage.value.covered,
    pool: coverage.value.pool,
    coverageKnown: coverage.value.ok,
    now: now.value,
  })
);

/** 四档计数（含 `unknown`，它会单独一行提示；四格只摆四档） */
const counts = computed(() => plan.value.counts);

/** 当前筛选的档；`''` = 不筛 */
const stage = ref<OrderStage | ''>('');

/** 筛过的清单（点分组 = 筛到该档，再点一下取消） */
const visible = computed(() =>
  stage.value ? plan.value.orders.filter((o) => o.stage === stage.value) : plan.value.orders
);

/** 「今天进来」四数与状态条（都来自容器，本组件不取数） */
const daily = computed(() => summary.value.daily);
const pulse = computed(() => summary.value.pulse);
const banner = computed(() => syncBanner(summary.value.sync));
const syncText = computed(() => banner.value.text);
const syncTone = computed(() => `is-${banner.value.tone}`);
const neverSynced = computed(() => isNeverSynced(summary.value.sync));

/** 已拿占比（0~100）。件数为 0 时不渲染进度条，这里只在有件数时被用到 */
const percent = computed(() => {
  const { pieces, taken } = daily.value;
  if (!(pieces > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((taken / pieces) * 100)));
});

/** 点分组：同档再点一次 = 取消（省一个"全部"按钮，也省一次点击） */
function pickStage(s: OrderStage): void {
  stage.value = stage.value === s ? '' : s;
}

/** 「开始处理」= 筛到**最卡的那一档**（缺图 → 待归类 → 待拿货 → 已备齐） */
function startFromWorst(): void {
  const first = STAGES.find((s) => counts.value[s] > 0);
  if (!first) return;
  stage.value = first;
  toast(`先处理 ${counts.value[first]} 单${STAGE_LABEL[first]}`, 'info');
}

const startTitle = computed(() => {
  const first = STAGES.find((s) => counts.value[s] > 0);
  return first ? `筛到最卡的一档：${counts.value[first]} 单${STAGE_LABEL[first]}` : '没有待处理的单';
});

function stageTitle(s: OrderStage): string {
  const n = counts.value[s];
  return n ? `${n} 单${STAGE_LABEL[s]} · 点一下只看这一档` : `没有${STAGE_LABEL[s]}的单`;
}

/** 行上的 chip 补充说明：还差几件 / 几行卡住（不要长到把状态词挤掉） */
function chipNote(o: OrderStageOrder): string {
  if (o.stage === 'waitingStock') return o.gap ? `差 ${o.gap} 件` : '';
  if (o.stage === 'ready') return '';
  if (o.stage === 'unknown') return '';
  return o.lines.length > 1 ? `${o.blocked}/${o.lines.length} 行` : '';
}

function actTitle(o: OrderStageOrder): string {
  if (o.stage === 'noImage') return '这一单没有买家图 —— 回芒果页面重抓一次通常就有了';
  if (o.stage === 'unclassified') return '带这一单的单号去「归类核对」';
  if (o.stage === 'waitingStock') return `带这一单的款色去「拿货」（还差 ${o.gap} 件）`;
  if (o.stage === 'unknown') return '这次判不出货齐没齐 —— 去「拿货」页按单核对一眼';
  return '复制单号并打开芒果待发货页 —— 发货在芒果点';
}

/** 有件数是按 1 兜底的（标出来，别让它看起来像个确定的数） */
function hasAssumed(o: OrderStageOrder): boolean {
  return o.lines.some((l) => l.assumedQty);
}

// ── 展开 / 收起（一次只开一单：清单本来就长，开多张会把人绕丢）────────────────
const openNo = ref('');

function isOpen(o: OrderStageOrder): boolean {
  return !!o.orderNo && openNo.value === o.orderNo;
}

function toggle(o: OrderStageOrder): void {
  if (!o.orderNo) return;
  openNo.value = openNo.value === o.orderNo ? '' : o.orderNo;
}

// ── 缩略图（合批）────────────────────────────────────────────────────────────
//
// 为什么在面板里读、而不在 `orderStages` 里读：那是纯函数（vitest 直接调），
// 里面出现 IPC 就没法测了。面板只负责"把这些路径批量换成 dataURL"。
// ⚠️ 合批是**必须**的：主进程一次最多 40 张（`orderImageThumbBatch` 内部按 40 拆批）。
// ⚠️ 失败静默：图读不出来不影响"还剩几小时"这条主线，留空占位即可。
const thumbs = ref<Record<string, string>>({});

/** 这张单用来出缩略图的那一行（第一张有图的） */
function firstImagePath(o: OrderStageOrder): string {
  return o.lines.find((l) => l.imagePath)?.imagePath ?? '';
}

watch(
  () => plan.value.orders.map((o) => firstImagePath(o)).join('|'),
  () => {
    void loadThumbs();
  },
  { immediate: true }
);

async function loadThumbs(): Promise<void> {
  const paths = [...new Set(plan.value.orders.map((o) => firstImagePath(o)).filter(Boolean))];
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

function thumbOf(o: OrderStageOrder): string {
  const p = firstImagePath(o);
  return p ? thumbs.value[p] ?? '' : '';
}

// ── 动作（每一个都带上下文，且**不写本地状态**）──────────────────────────────
//
// 归类：只传**单号**（归类页的搜索口径就是单号/店铺/款色文本，传行 id 会变成第二条匹配规则）。
function gotoClassify(o: OrderStageOrder): void {
  if (o.orderNo) classifyFocus.value = o.orderNo;
  go('classify');
}

/**
 * 拿货：带**款色**（拿货页是按厂家 + 款色组织的一大片宫格，只说"去拿货"等于把人丢进去自己找）。
 * 取第一个**卡住且有款色**的行 —— 那一行才是他这单要补的货。
 */
function gotoPurchase(o: OrderStageOrder): void {
  const blocked = o.lines.find((l) => l.stage === 'waitingStock' && l.styleCode) ??
    o.lines.find((l) => l.styleCode);
  if (blocked) {
    purchaseFocus.value = {
      orderNo: o.orderNo,
      styleCode: blocked.styleCode,
      color: blocked.color,
      remaining: blocked.gap ?? 0,
    };
  }
  go('purchase');
}

/**
 * 已备齐的主操作 = **复制单号 + 打开芒果待发货页**。
 *
 * 为什么不本地标记已发货：发货是平台侧的动作，应用里没有回写 `ship_time` 的路径
 * （`docs/notes` 已取证）。造一个本地开关只会和平台数据打架，第二天同步一回来就自相矛盾。
 * 先把单号放进剪贴板，是因为芒果那边的搜索框才是真正的下一步 —— 少一次手抄。
 */
async function actOn(o: OrderStageOrder): Promise<void> {
  if (o.stage === 'noImage') {
    void openMangoPending();
    return;
  }
  if (o.stage === 'unclassified') {
    gotoClassify(o);
    return;
  }
  if (o.stage === 'waitingStock' || o.stage === 'unknown') {
    gotoPurchase(o);
    return;
  }
  const ok = o.orderNo ? await copyNo(o) : false;
  toast(ok ? '单号已复制 —— 在芒果待发货页搜它' : '打开芒果待发货页，用单号找这一单', ok ? 'info' : 'error');
  void openMangoPending();
}

/** 复制单号（失败要 toast：剪贴板失败的唯一表现就是"粘贴出来是上一件东西"） */
async function copyNo(o: OrderStageOrder): Promise<boolean> {
  if (!o.orderNo) return false;
  const ok = await writeClipboard(o.orderNo);
  toast(ok ? `已复制单号 ${o.orderNo}` : '复制失败（剪贴板不可用）', ok ? 'success' : 'error');
  return ok;
}

/** 主入口：打开芒果待发货页（失败自己 toast，见 `mangoOpen`） */
function onOpenMango(): void {
  void openMangoPending();
}

/** 空态的「Excel 导入」：展开备选区**并立刻弹选文件**（一步直达，不让用户再找一次按钮） */
function onEmptyImport(): void {
  excelOpen.value = true;
  void importExcel();
}

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
  }
);
</script>

<style scoped>
/* 面板吃满高度，滚动只发生在清单容器上（页头 / 状态条 / 分组固定）—— 与「归类核对」同一套 */
.od-view {
  gap: 10px;
}

.od-panel {
  flex: 1 1 auto;
  min-height: 240px;
}

.od-scope {
  font-size: 12px;
  font-weight: 400;
  color: var(--wb-text-muted);
}

.od-acts {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-left: auto;
}

/* 采集状态条：轻（它是背景信息，不是主角），但失败时整条染色 —— 它挡的是"以为今天没单" */
.od-sync {
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

.od-sync__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.75;
}

.od-sync.is-ok .od-sync__dot {
  background: var(--wb-success);
  opacity: 1;
}

.od-sync.is-idle .od-sync__dot {
  background: var(--wb-warning);
  opacity: 1;
}

.od-sync.is-warn {
  color: var(--wb-warning);
}

.od-sync.is-error {
  color: var(--wb-danger);
}

.od-sync__tag {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 11px;
  line-height: 16px;
}

/* ---- 今天进来（一行口径说明）------------------------------------------------
   刻意压成一行：它与下面的四档是**两级信息**。做成两块一样重的卡片，"我有几单要发"
   就又变成两个答案（这正是本轮要修的那个问题）。 */
.od-brief {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 6px;
  flex-shrink: 0;
  margin: 6px 14px 0;
  padding: 6px 10px;
  border-radius: var(--wb-radius);
  background: var(--wb-surface-2);
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}

.od-brief__label {
  color: var(--wb-text);
  font-weight: 600;
}

.od-brief b {
  color: var(--wb-text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.od-brief b.is-done {
  color: var(--wb-success);
}

/* 进度条：细、短，只为"还剩多少"给一眼可见的比例（不抢四档的注意力） */
.od-brief__bar {
  display: inline-block;
  width: 96px;
  height: 5px;
  border-radius: 999px;
  background: var(--wb-border);
  overflow: hidden;
}

.od-brief__fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--wb-primary);
  transition: width 0.2s ease;
}

@media (prefers-reduced-motion: reduce) {
  .od-brief__fill {
    transition: none;
  }
}

.od-brief__scope,
.od-brief__hint {
  color: var(--wb-text-muted);
}

/* ---- 状态分组（这一屏的主结构）--------------------------------------------- */
.od-stages {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
  margin: 10px 14px 0;
}

.od-stages__row {
  display: flex;
  align-items: stretch;
  flex-wrap: wrap;
  gap: 6px;
}

/* 一格 = 一个数字 + 一个词。四格**并排且同宽**（它们是同一维度的四个取值，
   宽窄不一会被读成"轻重不同"）；点一下筛到该档，选中态用边框 + 底色标出来。 */
.od-stage {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  min-width: 84px;
  padding: 5px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  color: var(--wb-text);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
}

.od-stage:hover {
  background: var(--wb-hover);
}

.od-stage b {
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* 选中：主色边框 + 主色文字（不靠背景色差 —— 深色主题下那点差读不出来） */
.od-stage.is-on {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
  box-shadow: inset 0 0 0 1px var(--wb-primary);
}

/* 0 的那一格不染色、不加粗焦点：它没活要干，别跟非零的抢视线 */
.od-stage.is-zero {
  color: var(--wb-text-muted);
}

.od-stage.is-zero b {
  font-weight: 500;
}

.od-stage.is-noImage b {
  color: var(--wb-danger);
}

.od-stage.is-unclassified b {
  color: var(--wb-warning);
}

.od-stage.is-ready b {
  color: var(--wb-success);
}

.od-stage.is-zero b {
  color: inherit;
}

/* 主按钮跟在四格右边；窄窗换行时靠左（它与四格是同一组） */
.od-start {
  flex-shrink: 0;
}

.od-sum {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}

.od-sum b {
  color: var(--wb-text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.od-sum b.is-warn {
  color: var(--wb-warning);
}

/* 「算不出来」「判不出来」这类声明：虚线左边框（不是错误提示，是可信度声明） */
.od-hint {
  margin: 2px 14px 0;
  padding-left: 8px;
  border-left: 2px dashed var(--wb-border);
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-text-muted);
  flex-shrink: 0;
}

.od-hint--warn {
  color: var(--wb-warning);
  border-left-color: color-mix(in srgb, var(--wb-warning) 55%, transparent);
}

/* ---- 清单 ------------------------------------------------------------------ */
/* 唯一滚动区（`.wb-panel` 是 overflow:hidden，不套这层会被**静默裁掉**右半截） */
.od-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin-top: 8px;
  border-top: 1px solid var(--wb-border);
}

.od-row {
  border-bottom: 1px solid var(--wb-border);
}

.od-row:hover .od-row__head {
  background: var(--wb-hover);
}

.od-row.is-open .od-row__head {
  background: var(--wb-surface-2);
}

/* 已超时 / 快超时：整行左侧竖条（与以前清单同一套语言 —— "越紧急越靠上"要能被扫视确认） */
.od-row.is-overdue .od-row__head {
  box-shadow: inset 2px 0 0 var(--wb-danger);
}

.od-row.is-risk .od-row__head {
  box-shadow: inset 2px 0 0 var(--wb-warning);
}

/* 一行订单：chev + 图 + 单号 + 店 + 件 + 剩余 + 状态 + 动作。
   用 grid 而不是 flex：列要对齐（一屏几十行，列不齐就没法扫）。 */
.od-row__head {
  display: grid;
  grid-template-columns: 14px 36px minmax(120px, 1.4fr) minmax(70px, 1fr) 62px 92px 96px auto;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  cursor: pointer;
}

.od-row__chev {
  font-size: 11px;
  color: var(--wb-text-muted);
}

.od-thumb {
  display: block;
  width: 32px;
  height: 32px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  object-fit: cover;
}

/* 没图：留一个虚线空框 —— 空白会让人以为"这一列没加载出来"，
   虚线框说的是"这一行确实没有图"（与「缺图」chip 指向同一件事）。 */
.od-thumb--empty {
  border: 1px dashed var(--wb-border-strong);
}

.od-row__no {
  font-family: var(--wb-mono, monospace);
  font-size: 12.5px;
  color: var(--wb-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.od-row__shop,
.od-row__pieces {
  font-size: 12px;
  color: var(--wb-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.od-row__pieces {
  font-variant-numeric: tabular-nums;
}

.od-row__remain {
  font-size: 12px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}

.od-row__remain.is-overdue {
  color: var(--wb-danger);
  font-weight: 600;
}

.od-row__remain.is-risk {
  color: var(--wb-warning);
  font-weight: 600;
}

/* 没有截止期：弱化但写「不知道」（不用破折号 —— 破折号会被读成"没有这个字段所以不重要"） */
.od-row__remain.is-unknown {
  color: var(--wb-text-muted);
}

/* 状态 chip：四档四种语义色。缺图=红（印不了）、待归类=橙（还没到拿货）、
   待拿货=橙弱一档、已备齐=绿、待核对=虚线灰（判不出来，别给它一个"正常"的颜色）。 */
.od-chip {
  display: inline-block;
  justify-self: start;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--wb-border);
  font-size: 11.5px;
  line-height: 17px;
  white-space: nowrap;
  color: var(--wb-text-muted);
  background: var(--wb-surface-2);
}

.od-chip.is-noImage {
  color: var(--wb-danger);
  border-color: color-mix(in srgb, var(--wb-danger) 45%, transparent);
}

.od-chip.is-unclassified {
  color: var(--wb-warning);
  border-color: color-mix(in srgb, var(--wb-warning) 45%, transparent);
}

.od-chip.is-waitingStock {
  color: var(--wb-warning);
  border-style: dashed;
}

.od-chip.is-ready {
  color: var(--wb-success);
  border-color: color-mix(in srgb, var(--wb-success) 45%, transparent);
}

.od-chip.is-unknown {
  color: var(--wb-text-muted);
  border-style: dashed;
}

.od-chip--sm {
  font-size: 11px;
  padding: 0 6px;
}

.od-row__act {
  justify-self: end;
  white-space: nowrap;
}

/* ---- 明细行 ---------------------------------------------------------------- */
.od-lines {
  padding: 4px 14px 10px 56px;
  background: var(--wb-surface-2);
  border-top: 1px dashed var(--wb-border);
}

.od-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  color: var(--wb-text);
}

.od-line + .od-line {
  border-top: 1px solid var(--wb-border);
}

.od-line__name {
  min-width: 180px;
}

.od-line__qty {
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}

.od-line__cov {
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 「推算」= 这一行用了无归属台账（不是事实）。小、弱，但**不能省** */
.od-line__tag {
  padding: 0 5px;
  border-radius: 999px;
  border: 1px dashed var(--wb-border-strong);
  font-size: 10.5px;
  line-height: 15px;
  color: var(--wb-text-muted);
}

.od-lines__foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 8px;
  margin-top: 2px;
  border-top: 1px solid var(--wb-border);
}

.od-lines__foot-hint {
  margin-left: auto;
  font-size: 12px;
  color: var(--wb-text-muted);
}

/* ---- 空态 ------------------------------------------------------------------ */
.od-empty {
  padding: 24px 20px 28px;
  flex-shrink: 0;
}

.od-empty--filter {
  padding: 16px 20px;
  font-size: 13px;
  color: var(--wb-text-muted);
}

.od-empty__main {
  margin: 0 0 8px;
  font-size: 15px;
  color: var(--wb-text);
}

.od-empty__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}

.od-empty__cta {
  align-self: flex-start;
  margin-top: 2px;
}

/* Excel 备选区：独立一块（不套 .wb-panel —— 它自己由几个小块组成，套两层卡会比主入口还重） */
.od-excel {
  flex-shrink: 0;
  padding: 12px 14px 14px;
  border: 1px dashed var(--wb-border-strong);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
}
</style>
