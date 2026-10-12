<template>
  <div class="wb-page pk-view" :class="{ 'is-embedded': embedded }">
    <!-- 页头：**只在独立页**（「拣货」模块）出现。内嵌进「发货台 › 拿货」时整块不渲染 ——
         标题由外层页签交代，而"导出 / 更多"两个动作移到下面的精简条上（不能随页头一起消失）。 -->
    <header v-if="!embedded" class="wb-head">
      <div class="wb-head__main">
        <h1 class="wb-head__title">拣货</h1>
        <p class="wb-head__desc">
          按未发货订单汇总「还要拿什么、各几件、图与供应商在哪、大概多少钱」，按厂家分组 —— 可导出带图
          xlsx，也可以把某家的清单图直接复制给厂家
        </p>
      </div>
      <div class="wb-head__actions">
        <button
          class="wb-btn wb-btn--primary"
          data-act="generate"
          :disabled="loading"
          @click="generate"
        >
          {{ loading ? '生成中…' : summary.groups.length ? '重新生成' : '生成待拣清单' }}
        </button>
        <button
          class="wb-btn"
          data-act="export"
          :disabled="loading || !summary.groups.length"
          @click="exportXlsx"
        >
          导出带图 xlsx
        </button>
        <button
          class="wb-btn"
          data-act="more"
          :class="{ 'is-on': showMore }"
          @click="showMore = !showMore"
        >
          {{ showMore ? '收起' : '更多' }}
        </button>
      </div>
    </header>

    <!-- 精简条（两种宿主共用）：只剩「这批数是怎么筛出来的（口径）/ 有什么缺口 / 能做什么」——
         三个数（待拿款色 / 件数 / 预估金额）移到**底部汇总条**（`pk-sum`）上，与逐厂动作同屏。
         ⚠️ 缺口只在**有缺口**时出现（全齐就不占地方）。 -->
    <div class="pk-bar pk-topbar" data-act="pk-bar">
      <span v-if="summary.groups.length && gapsText" class="wb-muted pk-bar__gaps" data-act="gaps"
        >缺：{{ gapsText }}</span
      >
      <span v-else-if="loading" class="wb-muted">正在汇总…</span>
      <span class="pk-bar__spacer"></span>
      <!-- 默认条件**写在界面上**（不藏进设置）：看不到默认值，用户就会怀疑数字。
           ⚠️ 天数这一格显示的是 **`scopeDays`（本次清单实际用的那个数）**，不是输入框的 ref ——
           两者会在"刚改完还没重算"的那一瞬不一致，而这一格恰恰是"这批数是怎么筛出来的"的唯一交代。 -->
      <span class="wb-muted pk-bar__scope" data-act="scope">
        未发货 · {{ daysText(scopeDays) }}<template v-if="shopPick"> · {{ shopPick }}</template>
        <span v-if="summary.excludedFinished" data-act="excluded-finished"
          > · 排除已终结 {{ summary.excludedFinished }} 行</span
        >
        <span v-if="summary.excludedOld"> · 超窗剔除 {{ summary.excludedOld }} 行</span>
        <span v-if="summary.undated" data-act="undated-hint"
          > · 无下单日期 {{ summary.undated }} 行（照收）</span
        >
        <span v-if="summary.shippedRows"> · 含已发货 {{ summary.shippedRows }} 行</span>
      </span>
      <!-- 内嵌时页头不渲染 ⇒ 导出 / 更多跟着精简条走（藏了就没有可点的入口了） -->
      <button
        v-if="embedded"
        class="wb-btn wb-btn--sm"
        data-act="export"
        :disabled="loading || !summary.groups.length"
        @click="exportXlsx"
      >
        导出带图 xlsx
      </button>
      <button
        v-if="embedded"
        class="wb-btn wb-btn--sm"
        data-act="more"
        :class="{ 'is-on': showMore }"
        @click="showMore = !showMore"
      >
        {{ showMore ? '收起' : '更多' }}
      </button>
    </div>

    <div v-if="showMore" class="pk-more">
      <div class="pk-actions--wrap">
        <label class="pk-field">
          天数窗
          <input
            v-model.number="days"
            class="wb-input wb-input--sm pk-input--num"
            type="number"
            min="0"
            max="3650"
          />
          天（0 = 不限）
        </label>
        <select
          v-model="shopPick"
          class="wb-input wb-input--sm"
          data-act="shop-pick"
          :disabled="loading"
        >
          <option value="">全部店铺</option>
          <option v-for="s in shops" :key="s" :value="s">{{ s }}</option>
        </select>
        <label class="pk-field">
          <input v-model="includeShipped" type="checkbox" data-act="include-shipped" />
          连已发货一起看（对照用）
        </label>
      </div>
    </div>

    <p v-if="error" class="pk-error">
      {{ error }}
      <!-- 内嵌时页头不渲染、没有「生成」按钮 ⇒ 取数失败必须就地给一条重试，否则只能等数据变动 -->
      <button v-if="embedded" type="button" class="wb-link" data-act="retry" @click="generate">
        重试
      </button>
    </p>

    <!-- 空态分两种（UX 审查 D3/P0-3）：「还没生成过」是引导动作；「生成过但没货可拣」要说清为什么空。
         文案逐字保留（冒烟按 textContent 断言）。 -->
    <div v-if="!summary.groups.length && !loading" class="wb-empty pk-empty" data-act="empty">
      <span class="wb-empty__icon" v-html="ICON.empty"></span>
      <template v-if="!generated">
        <p class="wb-empty__title">还没生成过待拣清单</p>
        <p class="wb-empty__desc">
          点「生成待拣清单」→ 按未发货订单汇总出 图 / 款色码 / 件数 / 供应商
        </p>
      </template>
      <template v-else-if="summary.scanned">
        <p class="wb-empty__title">没有要拣的货</p>
        <!-- ⚠️ 2026-10-10：**按实际生效的那条口径分说**，不再把「已终结」与「超窗」并成一句。
             合并写法给出的两个动作各自只对一半场景有效（「连已发货一起看」对超窗毫无作用、
             「把天数窗调大」对已终结毫无作用）—— 用户照做一次没变化，只能认为这东西坏了。 -->
        <p class="wb-empty__desc">
          扫了 {{ summary.scanned }} 行未发货订单，{{ emptyReason.text }}
        </p>
        <div v-if="emptyReason.widen" class="wb-empty__actions">
          <button class="wb-btn wb-btn--primary" data-act="empty-widen" @click="widenDays">
            打开「更多」调天数窗
          </button>
        </div>
      </template>
      <template v-else>
        <p class="wb-empty__title">一行订单都没扫到</p>
        <p class="wb-empty__desc">
          这批条件下一行订单都没扫到 —— 若还没导过订单，去「发货台」点「导入 Excel」导一份订单报表。
        </p>
        <div class="wb-empty__actions">
          <button class="wb-btn wb-btn--primary" data-act="empty-import" @click="goImport">
            去「发货台」导入
          </button>
        </div>
      </template>
    </div>

    <!-- 2026-10-10 卡片网格重设计：**一张卡 = 一个款色**（图 + 尺码角标条 + 款名 + 预估小计），
         顶部厂家标签筛选，底部汇总条逐厂收口 —— 一条链上"看货 → 复制发厂家 → 生成拿货单"
         三件事各就各位（原先"表格 + 段标题"两层嵌套，元素多、行高密、动作散）。 -->
    <template v-else-if="summary.groups.length">
      <!-- 厂家筛选标签：数 = **待拿款色数**（有货要拿的厂家才占一格；一家的待拿货为 0 就不占位）。
           一个可筛的都没有时整行不渲染（只剩「全部」的标签栏是纯噪声）。
           「未指定厂家」也是独立一档（data-supplier="0"）——它的货要能看到，但不该混进别家的筛选里。 -->
      <div v-if="supplierTabs.length" class="pk-tabs" data-act="pk-tabs">
        <button
          type="button"
          class="pk-tab"
          :class="{ 'is-on': supplierFilter === 'all' }"
          data-act="pk-tab-all"
          @click="supplierFilter = 'all'"
        >
          全部 <b>{{ pending.colors }}</b>
        </button>
        <button
          v-for="t in supplierTabs"
          :key="t.supplierId"
          type="button"
          class="pk-tab"
          :class="{ 'is-on': supplierFilter === t.supplierId }"
          data-act="pk-tab"
          :data-supplier="t.supplierId"
          @click="supplierFilter = t.supplierId"
        >
          {{ t.name }} <b>{{ t.colors }}</b>
        </button>
      </div>

      <div class="pk-cards" data-act="pk-grid">
        <!-- 一张卡 = 一个款色（含全部尺码）。已拿完 / 已忽略的排到最后并调暗（还不用动的东西不抢眼）。 -->
        <article
          v-for="c in cards"
          :key="c.r.key"
          class="pk-card"
          :class="{ 'is-off': c.r.ignored, 'is-done': !c.r.ignored && c.r.remaining <= 0 }"
          :data-key="c.r.key"
          data-act="pk-card"
        >
          <div class="pk-card__imgs">
            <img v-if="thumbs[c.r.imagePath]" class="pk-card__img" :src="thumbs[c.r.imagePath]" alt="" />
            <span v-else class="pk-card__noimg">缺图</span>
            <span class="pk-card__sup" :class="{ 'is-missing': !c.r.supplierId }">{{ c.supplierName }}</span>
            <!-- 尺码角标条（压在图的底边）：`L×2` = 这一码**还要拿** 2 件；`L✓` = 已拿完。
                 tooltip 里是这一码的「需求 · 已拿 · 还差」三个数 —— 折叠展示，不丢数。
                 ⚠️ 非本卡自造的叠加层：这层半透明底用 `--wb-overlay` 令牌（不写死色值）。 -->
            <span class="pk-card__sizes" data-act="sizes">
              <span
                v-for="s in c.r.sizes"
                :key="s.size"
                class="pk-chip"
                :class="{ 'is-done': s.remaining <= 0, 'is-off': c.r.ignored }"
                data-act="size-chip"
                :data-size="s.size"
                :title="chipTitle(s)"
                >{{ chipText(s) }}</span
              >
            </span>
          </div>
          <div class="pk-card__body">
            <div class="pk-card__head">
              <span class="pk-card__key wb-mono">{{ c.r.key }}</span>
              <!-- 四态：**已忽略**（整款色不补）> **已拿完**（还差 0）> 缺哪一环（含无进价）> 齐。
                   "已拿完"必须与"齐"分开说：一个是"不用再拿了"，一个是"这行照它拿"。 -->
              <span v-if="c.r.ignored" class="wb-tag pk-tag is-warn" data-act="row-ignored">已忽略</span>
              <span v-else-if="!c.r.remaining && c.r.taken" class="pk-ok" data-act="row-taken-all">已拿完</span>
              <span v-else-if="rowGaps(c.r).length" class="wb-tag pk-tag is-warn" data-act="row-gaps">{{
                rowGaps(c.r).join(' · ')
              }}</span>
              <span v-else class="pk-ok">齐</span>
            </div>
            <p v-if="c.r.styleName" class="pk-card__name">{{ c.r.styleName }}</p>
            <div class="pk-card__foot">
              <span
                v-if="c.amount"
                class="pk-card__amount"
                :class="{ 'is-none': !c.hasPrice }"
                data-act="card-amount"
                title="预估 = 还要拿的件数 × 已查到的进价；不含无进价的件"
                >{{ c.amount }}</span
              >
              <span
                class="pk-card__unit"
                title="进价（元/件）：成本表里按订单日期生效的那条；— = 没查到价"
                ><span data-act="unit-price">{{ c.unitText }}</span
                ><template v-if="c.hasPrice"> 元/件</template></span
              >
              <span class="pk-card__spacer"></span>
              <!-- 行尾只发**意图**：确认弹层（要用户敲原因）与写库都在宿主（「拿货」页）——
                   本组件不认识 `purchase*` 写通道，也不该把确认弹层再实现一遍。
                   忽略按**款色**整组生效（`ignoreKey` 里没有码）⇒ 动作挂在款色卡上。 -->
              <button
                v-if="rowAction && !c.r.ignored"
                type="button"
                class="wb-link"
                :data-act="`pk-ignore-${c.r.key}`"
                @click="emit('ignore', { styleCode: c.r.styleCode, color: c.r.color, remaining: c.r.remaining })"
              >
                忽略
              </button>
              <button
                v-else-if="rowAction"
                type="button"
                class="wb-link"
                :data-act="`pk-unignore-${c.r.key}`"
                @click="emit('unignore', { styleCode: c.r.styleCode, color: c.r.color })"
              >
                取消忽略
              </button>
            </div>
          </div>
        </article>
      </div>

      <!-- 底部汇总条（吸底）：一行一个厂家 = 「这家什么情况 + 复制发哪家 + 一键开单」。
           一件一单的约束（一张拿货单只能挂一个厂家）直接落在行上，不用先选厂家再对一遍。
           ⚠️ 必须吸底（sticky）而不是随列表滚：它会随着卡片多寡被顶到几十屏之外，
           而"生成拿货单"是这条链的下一步动作，找不到就等于没有。 -->
      <div class="pk-sum" data-act="pk-sum">
        <div
          v-for="sec in sections"
          :key="sec.sg.supplierId"
          class="pk-sum-row"
          :class="{ 'is-missing': !sec.sg.supplierId }"
          data-act="pk-sum-row"
          :data-supplier="sec.sg.supplierId"
        >
          <span class="pk-sum-row__name">{{ sec.sg.supplierName || '未指定厂家' }}</span>
          <span class="pk-sum-row__meta">{{ sectionMeta(sec) }}</span>
          <span v-if="!sec.sg.supplierId" class="pk-sum-row__hint"
            >给产品补上供应商，这些货才会归到厂家名下</span
          >
          <span class="pk-sum-row__spacer"></span>
          <button
            v-if="sec.sg.supplierId && sec.pending.pieces > 0"
            type="button"
            class="wb-btn wb-btn--sm"
            data-act="pk-copy"
            :data-supplier="sec.sg.supplierId"
            :disabled="copyingId === sec.sg.supplierId"
            @click="copyForSupplier(sec)"
          >
            {{ copyingId === sec.sg.supplierId ? '生成中…' : '复制给厂家' }}
          </button>
          <button
            v-if="supplierAction && sec.sg.supplierId && sec.pending.pieces > 0"
            type="button"
            class="wb-btn wb-btn--sm wb-btn--primary"
            data-act="pk-create-order"
            :data-supplier="sec.sg.supplierId"
            @click="emit('supplier-action', sec.sg.supplierId)"
          >
            生成拿货单（{{ sec.pending.pieces }} 件）
          </button>
        </div>
        <!-- 总账：与「复制 / 生成」同一判据（待拿 = 还差 > 0 且未忽略，`pendingRollup` 一处算）。
             一件价都没查到时不写 `¥0.00`（那等于说"这批货值 0 元"），走 `amountText` → `—`。 -->
        <div class="pk-sum__total pk-metric" data-act="amount">
          <template v-if="pending.colors">
            待拿 <b>{{ pending.colors }}</b> 款色 · <b>{{ pending.pieces }}</b> 件 · 预估
            <b>{{ amountText(pending.amount, pending.noPricePieces, pending.pieces) }}</b>
            <span v-if="pending.noPricePieces" class="wb-muted">{{
              noPriceNote(pending.noPricePieces, pending.pieces)
            }}</span>
          </template>
          <span v-else class="wb-muted">清单里的货都已拿完或已忽略 —— 没有要拿的货</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// 「拣货」视图（2026-10-10 卡片网格重设计）：一键生成 → 按款色汇总"要拿什么、各几件、图与供应商在哪、
// 大概多少钱" → 卡片网格（顶部厂家标签筛选）→ 底部汇总条逐厂「复制给厂家 / 生成拿货单」→ 导出带图 xlsx。
//
// 口径（别改，与订单利润页**同一份实现**）：
//   · 件数 `resolveQty`（结算商品行真值 → 报表块 `商品数量` → 按 1 件并标缺）；
//   · 分组键 `skuKey`（款 × 色 × 码，缺哪段标哪段）；
//   · 进价 `pickUnitCost`（款级成本区间 `ae_cost_map`，按该行下单日期取当时生效的那条）——
//     所以同一条订单在「拣货」与「算钱」两页上的成本是同一个数；
//   · 范围：**未发货**（宿主按机械事实筛）+ **近 30 天** + **已终结（关闭/已完成）不拣**（`bucketOfStatus`）。
// 界面上把默认条件写成标签（含被剔除的行数），缺件数/缺图/缺供应商/无进价逐卡标 ——
// 拣货单是"照它干活"的东西，少一行就是少发一件货、漏一个价就是少带一笔钱。
//
// 取数四路（全部经 core 服务，视图内零算术）：
//   1. 订单行投影（含三层回落后的图）→ `pickingRows`
//   2. 结算商品行件数                → `settleOrders`（键口径 `settleQtyKey`）
//   3. 款级成本区间（进价唯一来源）  → `aeCostMapList`
//   4. 缩略图（合批一次往返）        → `orderImageThumbBatch`
//   动作：导出 `pickingExportExcel`（主进程 exceljs）· 复制发厂清单图 `writeClipboardImage`
import { computed, onMounted, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import { switchModule } from '@/core/services/shell';
import { writeClipboardImage } from '@/core/services/clipboard';
import * as ipc from '@/core/services/ipc';
import {
  aggregatePicking,
  DEFAULT_PICKING_DAYS,
  groupByColor,
  ignoreKey,
  pendingRollup,
  takenKey,
  type PendingRollup,
  type PickingColorGroup,
  type PickingGroup,
  type PickingSizeCell,
  type PickingSupplierGroup,
  type PickingSummary,
} from '@/lib/picking';
import { settleQtyKey, type CostInterval, type SettleQtyInfo } from '@/lib/orderCost';
import { domToJpeg, encodeImagesForExport, sizeQtyBadge } from '@/lib/pickingExport';
import {
  amountText,
  money,
  noPriceNote,
  renderSheetPng,
  sheetModelOf,
} from '@/lib/pickingSheet';
import type { IgnoreRow, OutstandingRow } from '@/types';

/**
 * `embedded` = 被「发货台」页的页签内嵌（藏掉本页自己的页头，避免"标题下面又一个标题"）。
 * `refreshToken` = 宿主的数据版本号：订单/映射一变，`today` 那边 +1 ⇒ 本页跟着重算。
 *   为什么必须有它：页签是 `KeepAlive` 保活的，不重算就会**一直显示刚才那份清单**——
 *   保活的代价（看到旧数据）必须这样还回去。
 * `auto` = 挂载即生成（**由外层显式指定**，不按"是否内嵌"隐式推断）。
 *   为什么单独一个 prop 而不是"内嵌就自动"：两种宿主对"这一屏是什么"的回答不同 ——
 *   独立页是**快照工具**（进页面不动手就不该取数，冒烟钉着"首屏不自动取数"）；
 *   而并进「拿货」后它是那一步的**入口视图**（"要拿什么"应当一眼可读，还得让
 *   「按此生成拿货单」有东西可拿）⇒ 两种语义都真实存在，写成一个 prop 才不会互相改坏。
 * `rowAction` = 卡片角给「忽略 / 取消忽略」链接（宿主提供，本组件只发意图，不碰拿货数据）。
 * `supplierAction` = 底部汇总条上给「生成拿货单（N 件）」（宿主提供，本组件只发"这家厂"的意图）。
 *   为什么钉在**厂家行**上而不是页级一个按钮：一张拿货单只能挂**一个厂家**（下游按厂家发单/对账），
 *   页级按钮必然先拉一个"选厂家"的下拉——那一步对用户是白问的，数据里已经分好行了。
 */
const props = withDefaults(
  defineProps<{
    embedded?: boolean;
    refreshToken?: number;
    auto?: boolean;
    rowAction?: boolean;
    supplierAction?: boolean;
  }>(),
  { embedded: false, refreshToken: 0, auto: false, rowAction: false, supplierAction: false }
);

/**
 * `go-import`  空态里的「去导订单」（内嵌时外层接管；本组件不认识页签，只发一个意图）
 * `generated`  清单重算完成 → 把**这一份**清单交给外层（「拿货」据此数"要拿几张/几件"）
 * `ignore` / `unignore`  卡上动作的**意图**（真正的写库与确认弹层由宿主做：
 *   本组件不认识 `purchase*` 写通道，也不该把确认弹层再实现一遍）。
 *   ⚠️ 忽略是**整款色**生效的（同 `lib/picking` 的 `ignoreKey`）⇒ 载荷不带 `size`；
 *   带上反而让宿主以为"只忽略这一码、别的码继续要"。
 * `supplier-action`  汇总条上「生成拿货单」的意图（载荷 = 厂家 id，只发厂商、不带明细：
 *   明细由宿主从**自己刚算过的同一份清单**里取，避免"按钮说 12 件、单里 14 件"两套口径）
 */
const emit = defineEmits<{
  (e: 'go-import'): void;
  (e: 'generated', groups: PickingGroup[]): void;
  (e: 'ignore', row: { styleCode: string; color: string; remaining: number }): void;
  (e: 'unignore', row: { styleCode: string; color: string }): void;
  (e: 'supplier-action', supplierId: number): void;
}>();

/** 空态图标（内联 SVG，跟随 currentColor） */
const ICON = {
  empty:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/><path d="M8 10.2v4"/></svg>',
};

const loading = ref(false);
const error = ref('');
/** 本页是否**生成过**：空态要分"还没点过"与"点了但没货可拣"两种（后者得说清为什么空） */
const generated = ref(false);
/** 低频筛选默认收起（界面精简）：天数窗 / 店铺 / 含已发货 */
const showMore = ref(false);
const days = ref(DEFAULT_PICKING_DAYS);
const shopPick = ref('');
const includeShipped = ref(false);
const shops = ref<string[]>([]);

/** 缩略图边长：96 太小 —— 导出时要以它为准转 JPEG 嵌进 Excel（发厂家看图认货），
 *  且**尺码×件数角标要烧进图里**（角标字号按图短边的比例算，图太小字就糊了）；
 *  200 在卡片里也更清晰。 */
const THUMB_EDGE = 200;
/** 缩略图缓存：本地路径 → dataUrl（同款色的多卡共用一张，合批只取一次） */
const thumbs = ref<Record<string, string>>({});

const EMPTY: PickingSummary = aggregatePicking([], { today: '' });
const summary = ref<PickingSummary>(EMPTY);

/**
 * 天数窗的中文说法。
 * ⚠️ `0` **不能说成「近 0 天」** —— 它的含义是"不限"（`cutoffDate` 见 `lib/picking`），
 * 说成 0 天会读成"只看今天的单"，正好相反。
 */
function daysText(d: number): string {
  return d > 0 ? `近 ${d} 天` : '不限天数';
}

/**
 * 条件条上的天数窗 = **本次清单实际用的那个数**（`PickingSummary.days`）。
 *
 * 为什么不直接写输入框的 `days`：条件条回答的是"这批数是怎么筛出来的"，与**表里的数**同源才作数。
 * 正常流程下两者相等（`generate` 会跟着条件重算），但有三处会分开：① 还没生成过（此时显示输入值，
 * 那是"点一下会发生什么"的预告）② 取数失败/抛错（清单还是旧的）③ 有人日后去掉那条重算 watch。
 * 分开时的表现是「标签写着新条件、数还是旧的」—— 用户只能认为改坏了。
 */
const scopeDays = computed(() => (generated.value ? summary.value.days : days.value));

/**
 * 界面的**行动单位是"款色一张卡"**（2026-10-10 重设计）：同款同色所有尺码折进卡上的角标条。
 * `groupByColor` 是这层折叠的**唯一实现**（含排序：需求多者在前）。
 * 段（厂家）之间沿用 `summary.suppliers` 的顺序（未指定厂家整段排最后）。
 */
interface PickingSection {
  sg: PickingSupplierGroup;
  rows: PickingColorGroup[];
  pending: PendingRollup;
}
const sections = computed<PickingSection[]>(() =>
  summary.value.suppliers.map((sg) => {
    const rows = groupByColor(sg.groups);
    return { sg, rows, pending: pendingRollup(rows) };
  }),
);

/**
 * 底部总账 = **待拿**（还差 > 0 且未忽略）—— 与「生成拿货单（N 件）」同一判据（`pendingRollup`）。
 *
 * ⚠️ 为什么不用 `summary.remainingGroups / remainingPieces`：那两个含被忽略的组
 * （它们的定义是"总需求还差多少"）。两套数同时出现就会出现"条上说 4 件、按钮说 2 件"——
 * 用户没有任何办法判断哪个是对的。
 */
const pending = computed(() => pendingRollup(groupByColor(summary.value.groups)));

/** 厂家筛选：`'all'` 或厂家 id（含 0 = 未指定厂家）。只筛**网格**，不动底部总账。 */
const supplierFilter = ref<number | 'all'>('all');

interface SupplierTab {
  supplierId: number;
  name: string;
  colors: number;
}

/** 可筛的厂家 = **有待拿货**的段（数为待拿款色数）。一家都没有时标签行整行不渲染。 */
const supplierTabs = computed<SupplierTab[]>(() =>
  sections.value
    .filter((sec) => sec.pending.colors > 0)
    .map((sec) => ({
      supplierId: sec.sg.supplierId,
      name: sec.sg.supplierName || '未指定厂家',
      colors: sec.pending.colors,
    })),
);

/** 卡面上预先算好的展示字段（模板里不做算术 —— 金额口径全在 `lib/pickingSheet`，屏上图里同一套字面） */
interface PickingCard {
  r: PickingColorGroup;
  supplierName: string;
  /** 小计：`''`（不显示：已拿完/已忽略）/ `—`（全无价）/ `≈¥20.00` */
  amount: string;
  /** 单价文字：`10.00` / `—`（不带"元/件"后缀 —— 断言要求这格恰好是数字，单位挂在外面） */
  unitText: string;
  hasPrice: boolean;
}

/** 卡序（**全网格**统一）：**还要拿的排前面**，已拿完次之，已忽略最后（同档内维持「段序 + groupByColor 件数降序」） */
function cardRank(r: PickingColorGroup): number {
  return r.ignored ? 2 : r.remaining > 0 ? 0 : 1;
}

/** 卡面小计：已拿完 / 已忽略**不显示钱**（不是待拿就不该报一个数）；全无价写 `—` 不写 `≈¥0.00`。 */
function cardAmount(r: PickingColorGroup): string {
  if (r.ignored || r.remaining <= 0) return '';
  return r.pendingNoPricePieces >= r.remaining ? '—' : `≈¥${money(r.pendingAmount)}`;
}

const cards = computed<PickingCard[]>(() => {
  const out: PickingCard[] = [];
  for (const sec of sections.value) {
    if (supplierFilter.value !== 'all' && sec.sg.supplierId !== supplierFilter.value) continue;
    for (const r of sec.rows) {
      out.push({
        r,
        supplierName: sec.sg.supplierName || '未指定厂家',
        amount: cardAmount(r),
        unitText: r.unitPrice === null ? '—' : money(r.unitPrice),
        hasPrice: r.unitPrice !== null,
      });
    }
  }
  // 排序在**收集完之后**做（不是段内各排一遍）：网格是平铺的（段只体现在卡上的厂家胶囊），
  // 段内排序会被段序盖过 —— 厂A 整段被忽略后，那张调暗的卡仍会排在未指定厂家的待拿卡**前面**。
  // Array.sort 稳定 ⇒ 同档内维持「段序 + groupByColor 的件数降序」不变。
  out.sort((a, b) => cardRank(a.r) - cardRank(b.r));
  return out;
});

/** 正在生成/写剪贴板的厂家 id（0 = 空闲；未指定厂家没有复制按钮，不会撞上 0） */
const copyingId = ref(0);

/**
 * 「复制给厂家」：把**这一家**的待拿行画成一张清单图，写进系统剪贴板（用户粘到微信里发出去）。
 * 为什么是图而不是文字：厂家要照着备货，图里有货名、款色、尺码件数、单价的排版 ——
 * 纯文字粘进微信会丢表格结构，截屏又会把页签、别家的货一起发出去（见 `lib/pickingSheet` 头部）。
 * 数字全部与屏上同源（`sheetModelOf` 走 `pendingOf`），发出去的图与卡上的数不可能两套。
 */
async function copyForSupplier(sec: PickingSection): Promise<void> {
  if (copyingId.value) return;
  copyingId.value = sec.sg.supplierId;
  try {
    const model = sheetModelOf(summary.value.groups, {
      supplierId: sec.sg.supplierId,
      supplierName: sec.sg.supplierName,
      date: todayLocal(),
    });
    if (!model) {
      toast('这家没有要拿的货', 'info');
      return;
    }
    const dataUrl = await renderSheetPng(model, (p) => thumbs.value[p] ?? '');
    if (!dataUrl) throw new Error('清单图生成失败');
    const ok = await writeClipboardImage(dataUrl);
    if (!ok) throw new Error('写入剪贴板失败');
    const pieces = model.lines.reduce((n, l) => n + l.pieces, 0);
    toast(
      `已复制 ${model.lines.length} 款色 · ${pieces} 件 的清单图 —— 粘贴到微信里发给「${
        sec.sg.supplierName || '未指定厂家'
      }」`,
      'success',
    );
  } catch (e: unknown) {
    toast(`复制失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    copyingId.value = 0;
  }
}

/** 缺口汇总（一条里说完，全齐就不占地方）。「无进价」按**件数**说 —— "还有几件算不出钱"才是执行时要看的 */
const gapsText = computed(() => {
  const s = summary.value;
  const out: string[] = [];
  if (s.missingStyle) out.push(`未识别款 ${s.missingStyle}`);
  if (s.missingImage) out.push(`缺图 ${s.missingImage}`);
  if (s.missingSupplier) out.push(`缺供应商 ${s.missingSupplier}`);
  if (s.missingQty) out.push(`缺件数 ${s.missingQty}`);
  if (s.noPricePieces) out.push(`无进价 ${s.noPricePieces} 件`);
  return out.join(' · ');
});

/**
 * 图角标上的字（**导出 xlsx 用**，卡面已改尺码角标条）：`尺码×**还要拿的件数**`
 * （无图可挂 / 已拿完 / 已忽略 → 空串 = 不显示。`drawBadge('')` 与模板的 `v-if` 都按"空串 = 不画"处理）。
 *
 * ⚠️ **要拿的是"还差"不是"需求"**：这张图是直接发给厂家的 ——
 * 一件已拿 4 剩 2 的货，图上写 `L×6` 会让厂家照 6 件发。没建过拿货单时 `remaining === pieces`，
 * 所以"什么都没拿"的场景读起来仍是需求数，两种读法不冲突。
 */
function badgeOf(g: PickingGroup): string {
  return g.ignored || g.remaining <= 0 ? '' : sizeQtyBadge(g.size, g.remaining);
}

/**
 * 空态里"为什么空" —— 按**实际生效的口径**分说，并只说对得上那个口径的动作。
 *
 * 为什么必须分开（2026-10-10 实报）：两种原因的动作是**互斥**的 ——
 * 超窗只能"把天数窗调大"，已终结（关闭/已完成）**没有任何放宽办法**（单已经没了）。
 * 原先那句「都被『已终结 / 超窗』排除了」既不说是哪个，又同时给出两个动作 ⇒
 * 用户照着点了没变化，只能认为这一页坏了。
 */
const emptyReason = computed<{ text: string; widen: boolean }>(() => {
  const s = summary.value;
  const win = daysText(s.days);
  const old = s.excludedOld;
  const fin = s.excludedFinished;
  if (old > 0 && fin === 0) {
    return {
      text: `都被「超窗」排除了：这 ${old} 行比「${win}」更旧。把天数窗调大（0 = 不限）就能拣。`,
      widen: true,
    };
  }
  if (fin > 0 && old === 0) {
    return {
      text:
        `都被「已终结」排除了：这 ${fin} 行是关闭 / 已完成的单，拣了也白拣，放宽条件也变不出来。` +
        `若你确认它们还没终结，去「发货台」页的「导入订单」页签核一下那份报表有没有「订单状态」列 ——` +
        `没有这一列就判不出终结，也就不会误剔。`,
      widen: false,
    };
  }
  return {
    text: `两种原因都有：超窗 ${old} 行（不在「${win}」里）、已终结 ${fin} 行（关闭/已完成 —— 不用拣）。先调大天数窗看超窗那批。`,
    widen: true,
  };
});

/** 空态里的下一步：把天数窗调大 —— 真的**打开「更多」**（提示不是入口：让用户照着一个说法去找按钮，等于没给动作） */
function widenDays(): void {
  showMore.value = true;
}

/** 逐组的"缺什么"标签（**导出 xlsx 按码列**用；卡面上的缺口由 `rowGaps` 给）。
 *  ⚠️ 「无进价」也进这里 —— 它和缺图/缺件数同类："这行的数不全，别拿它当完整清单用"。 */
function groupGaps(g: PickingGroup): string[] {
  const out: string[] = [];
  if (g.missingQty) out.push(`缺件数 ${g.missingQty}`);
  if (g.missingImage) out.push(`缺图 ${g.missingImage}`);
  if (!g.supplierId) out.push('缺供应商');
  if (g.missingStyle) out.push('未识别款');
  if (g.unitPrice === null) out.push('无进价');
  return out;
}

/** 卡面缺什么（款色口径）：说**哪一类**缺了，不算"缺了几行" —— 一张卡一个款色，行数没有意义。
 *  ⚠️ 「无进价」按**件数**说：这一款色有几件算不出钱，才是执行时要看的。 */
function rowGaps(r: PickingColorGroup): string[] {
  const out: string[] = [];
  if (r.missingStyle) out.push('未识别款');
  if (r.missingImage) out.push('缺图');
  if (!r.supplierId) out.push('缺供应商');
  if (r.missingQty) out.push('缺件数');
  if (r.noPricePieces > 0) out.push(`无进价 ${r.noPricePieces} 件`);
  return out;
}

/** 尺码名（空码有专名：写 `×2` 会读成"乘以 2"） */
function sizeName(s: string): string {
  return s || '(无尺码)';
}

/** 尺码角标：`L×2` = 这一码**还要拿** 2 件；`L✓` = 已拿完
 *  （写 `L×0` 会读成"要拿 0 件"—— 与 `badgeOf` 同一取舍）。 */
function chipText(c: PickingSizeCell): string {
  return c.remaining > 0 ? `${sizeName(c.size)}×${c.remaining}` : `${sizeName(c.size)}✓`;
}

/** 尺码角标 tooltip：这一码的「需求 · 已拿 · 还差」—— 折叠展示，三个数一个都没丢 */
function chipTitle(c: PickingSizeCell): string {
  return `${sizeName(c.size)}：需求 ${c.pieces} · 已拿 ${c.taken} · 还差 ${c.remaining}`;
}

/** 厂家行上的「N 款色 · 待拿 N 件 · 预估 ¥/—（不含 N 件无进价）」。
 *  口径 = **待拿**（与「生成拿货单（N 件）」同一个数，`pendingRollup` 一处算）。
 *  用单串文本而不是几个元素拼 —— 相邻元素的 `textContent` 之间不插分隔符，拆开拼的字符串会缺空格。 */
function sectionMeta(sec: PickingSection): string {
  const p = sec.pending;
  if (p.colors > 0) {
    return `${p.colors} 款色 · 待拿 ${p.pieces} 件 · ${amountText(p.amount, p.noPricePieces, p.pieces)}${noPriceNote(p.noPricePieces, p.pieces)}`;
  }
  if (sec.rows.some((r) => r.ignored && r.remaining > 0)) return '余下已忽略（无需补货）';
  return '已拿齐';
}

function todayLocal(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 空态里的下一步：去导订单 —— 一行订单都没有时，用户其实缺的是"先导订单"。
 *  内嵌时发事件交给「发货台」页切到导入页签（`switchModule('today')` 会跳到本页再跳回来，等于没动）。 */
function goImport(): void {
  if (props.embedded) {
    emit('go-import');
    return;
  }
  switchModule('today');
}

/** 一键生成：取数 → 汇总 → 取缩略图（四路都在这里，界面只读结果） */
async function generate(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const res = await ipc.pickingRows({
      shop: shopPick.value,
      includeShipped: includeShipped.value,
    });
    if (!res.success || !res.data) throw new Error(res.error || '读取待拣订单失败');
    const rows = res.data.rows;

    // 结算商品行的件数（真值）：按可见订单号批量取一次，铺成查表（键口径由 `settleQtyKey` 单源给出）
    const settleQty: Record<string, SettleQtyInfo> = {};
    const orderNos = [...new Set(rows.map((r) => String(r.orderNo ?? '')).filter(Boolean))];
    if (orderNos.length) {
      const st = await ipc.settleOrders({ orderNos });
      if (st.success) {
        for (const row of st.data?.rows ?? []) {
          for (const it of row.items ?? []) {
            settleQty[settleQtyKey(row.orderNo, it.itemId)] = { lines: it.lines, qty: it.qty };
          }
        }
      }
    }

    // 进价/预估金额：取**款级成本区间**（`ae_cost_map`），与「算钱」页同一张表、同一份取价实现。
    // 读不到就传空数组 → 全部行标「无进价」（**不按 0 算**），不影响清单本身可用。
    const c = await ipc.aeCostMapList();
    const costs: CostInterval[] = (c.success ? (c.data ?? []) : []).map((x) => ({
      styleCode: String(x.styleCode ?? ''),
      effectiveFrom: String(x.effectiveFrom ?? ''),
      unitPrice: (Number(x.unitPriceCents) || 0) / 100,
      source: String(x.source ?? ''),
    }));

    // 已拿 / 已忽略（2026-10-10）：**与「拿货」页同一份口径** —— 已拿来自宿主 `outstanding()`
    // （已提交拿货单 qty 合计，按款色码），忽略来自 `purchase_ignore`（按款色，整组生效）。
    // 为什么必须同源：拣货单问的是"**还要**拿什么"，两处各算一次必然出现
    // "拿货页说拿完了、拣货单还说没拿"这类查不出的悬案（键口径由 `takenKey`/`ignoreKey` 单源给出）。
    // 读不到就按"没拿过 / 没忽略"处理 —— 只影响"还差"这一列，**不影响清单本身**。
    const og = await ipc.purchaseOutstanding();
    const ig = await ipc.purchaseIgnoreList();
    const taken: Record<string, number> = {};
    for (const r of (og.success ? (og.data ?? []) : []) as OutstandingRow[]) {
      taken[takenKey(r.styleCode, r.color, r.size)] = Number(r.taken) || 0;
    }
    const ignored = new Set(
      ((ig.success ? (ig.data ?? []) : []) as IgnoreRow[]).map((r) => ignoreKey(r.styleCode, r.color)),
    );

    summary.value = aggregatePicking(rows, {
      settleQty,
      costs,
      taken,
      ignored,
      days: days.value,
      today: todayLocal(),
    });
    generated.value = true;

    // 缩略图：只取"清单上真正要看的"那些图，合批一次往返（路径去重）
    const paths = [...new Set(summary.value.groups.map((g) => g.imagePath).filter(Boolean))];
    thumbs.value = {};
    if (paths.length) {
      const t = await ipc.orderImageThumbBatch(
        paths.map((localPath) => ({ localPath, maxEdge: THUMB_EDGE }))
      );
      if (t.success) {
        paths.forEach((p, i) => {
          const url = t.data?.dataUrls?.[i];
          if (url) thumbs.value[p] = url;
        });
      }
    }
  } catch (e: unknown) {
    error.value = `生成失败：${e instanceof Error ? e.message : '未知错误'}`;
    toast(error.value, 'error');
  } finally {
    loading.value = false;
  }
}

/**
 * 导出拣货单（**带图 + 按厂家分表**，供直接转发厂家）。
 *
 * 为什么不在渲染层用 `xlsx` 生成了：Excel 没有"图片作为单元格内容"的格式，嵌图必须走浮动图 +
 * 图片部件，社区版 SheetJS 不支持；主进程已有 `exceljs` 的嵌图先例（拿货单导出）。
 * **口径不搬家**：这里把已算好的行原样传过去（件数/进价/金额/缺口文案），主进程只画表 ——
 * 于是"导出的数"与"屏幕上的数"不可能不一致。
 *
 * 图：复用页面上**已经取回的缩略图**（不额外发 IPC），再用 canvas 统一转成 JPEG，
 * **并把尺码×件数角标烧进图里** —— 真实订单图大半是 WebP，而 Excel 嵌入的 WebP 在旧版 Office/WPS
 * 里显示不出来（详见 `lib/pickingExport`）。
 *
 * 行的顺序 = 清单顺序（有厂家的在前、未指定的最后），主进程按 `supplierName` 切表。
 */
async function exportXlsx(): Promise<void> {
  const groups = summary.value.groups;
  if (!groups.length) return;
  try {
    // 图先编码（顺序、失败不抛）：取不到的只是一行没图，不该让整个导出失败。
    // ⚠️ 键用**组键**而不是图片路径：同一张图可能被不同尺码的组共用，而角标（尺码×要拿件数）不同 ——
    //    按路径去重会把角标串味（L 那组显示成 XL 的件数，且不会报错）。
    const images = await encodeImagesForExport(
      groups.map((g) => ({
        key: g.key,
        localPath: g.imagePath,
        badge: badgeOf(g),
      })),
      { loadDataUrl: (p) => thumbs.value[p] ?? '', toJpeg: domToJpeg },
      THUMB_EDGE,
    );
    const rows = groups.map((g) => ({
      supplierName: g.supplierId ? g.supplierName : '',
      styleCode: g.styleCode,
      color: g.color,
      size: g.size,
      pieces: g.pieces,
      taken: g.taken,
      remaining: g.remaining,
      orders: g.orders,
      unitPrice: g.unitPrice,
      amount: g.unitPrice === null ? null : g.amount,
      gaps: g.ignored ? '已忽略（无需补货）' : groupGaps(g).join(' · '),
      image: images[g.key] ?? null,
    }));
    const r = await ipc.pickingExportExcel({ rows, defaultName: `拣货单-${todayLocal()}` });
    if (!r.success) {
      if (r.error === '__canceled__') return; // 用户点了取消：不算失败
      throw new Error(r.error || '导出失败');
    }
    const withImg = rows.filter((x) => x.image).length;
    toast(
      `已导出 ${groups.length} 个 SKU（共 ${summary.value.pieces} 件）· 按厂家分了 ${
        summary.value.suppliers.length
      } 张表 · ${withImg} 张图`,
      'success',
    );
  } catch (e: unknown) {
    const msg = `导出失败：${e instanceof Error ? e.message : '未知错误'}`;
    error.value = msg;
    toast(msg, 'error');
  }
}

// 数据变了（导入了订单 / 配了映射 / 改了成本）→ **已经生成过**的清单跟着重算；
// 没生成过就保持空态（本页的"一键语义"：进页不自动取数，冒烟有断言钉着）。
watch(
  () => props.refreshToken,
  () => {
    if (generated.value) void generate();
  }
);

// 改了筛选条件（天数窗 / 店铺 / 含已发货）→ 同样只在"已经生成过"时重算。
// 为什么必须有：条件条上的数就是"本次清单的口径"，不重算就会出现**标签写着新条件、数还是旧的**
//   —— 用户改了条件看见标签变了、数字没变，只能以为改坏了（2026-10-10 实报的邻接症状）。
// 为什么用 watch 而不是给控件加 @change：`v-model` 与 @change 在同一次事件里的先后无法保证，
//   读到旧值的静默 bug 比多跑一次取数更难查。
watch([days, shopPick, includeShipped], () => {
  if (generated.value) void generate();
});

// 清单变了就交给外层（「拿货」页据此数"给这家厂要拿几款/几件"并启用「按此生成拿货单」）。
// 为什么用 watch 而不是在 `generate()` 里 emit：`summary` 是**唯一的**清单出口（含以后新增的
// 取数路径）；钉在出口上，"换了取数方式却忘了通知外层"这类缝就不可能出现。
// 顺带把筛到一个"已经不在标签里"的厂家回落成「全部」—— 重算后那家可能已经没货要拿了，
// 不回落就会看到**空网格**（用户会以为整单空了）。
watch(summary, (s) => {
  emit('generated', s.groups);
  if (
    supplierFilter.value !== 'all' &&
    !supplierTabs.value.some((t) => t.supplierId === supplierFilter.value)
  ) {
    supplierFilter.value = 'all';
  }
});

onMounted(async () => {
  // 店铺清单（可选：读不到就只是不能按店铺筛，不影响生成）
  try {
    await ipc.shopDbEnsure();
    const sl = await ipc.shopList({ status: 'active' });
    if (sl.success)
      shops.value = (sl.data?.rows ?? []).map((r) => String(r.name ?? '')).filter(Boolean);
  } catch {
    /* 店铺域不可用不影响拣货 */
  }
  // `auto`（由外层显式指定）：并进「拿货」后「要拿什么」是那一步的入口视图，应当一眼可读。
  // ⚠️ 放在店铺清单之后：`generate()` 里店铺下拉只是筛选条件，不依赖它，但先拿到店铺能让
  //    自动生成的**第一次**就带上完整条件条（否则条件条少一格，用户看到的默认值与实际不一致）。
  if (props.auto) void generate();
});
</script>

<style scoped>
/* 页面外壳由全局 .wb-page 提供；精简条是组件自有的 `.pk-bar`（`.pk-topbar` 类名保留供冒烟断言）。 */

/* 内嵌在「发货台」页签里：顶上紧邻页签栏，全局那 18px 顶部留白会跟页签栏叠成一大块，
   收一点（其余边距不动 —— 与独立打开时保持同一套栅格）。 */
.pk-view.is-embedded {
  padding-top: 12px;
}

/* 内嵌时页头整块不渲染（标题由外层页签交代，动作在下面的精简条上）——
   原先那条"把页头按钮靠左"的规则随页头一起没了，别再加回来。 */

/* 精简条（两种宿主共用）：一行说完「缺什么 / 什么口径 / 能做什么」——
   三个数（待拿款色 / 件数 / 预估金额）不在这里，在底部汇总条上与逐厂动作同屏。
   白卡 + 自动换行 —— 窄窗口逐段折行，不裁不横滚。 */
.pk-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  padding: 9px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
  font-size: 13px;
}

/* 宽窗口把「口径」推到右端；窄窗口它自己折到下一行 */
.pk-bar__spacer {
  flex: 1 1 auto;
}

.pk-bar__scope {
  font-size: 12px;
}

.pk-tag {
  flex-shrink: 0;
}

.pk-more {
  padding: 11px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}

.pk-actions--wrap {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.pk-field {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--wb-text-muted);
}

.pk-input--num {
  width: 68px;
  text-align: right;
}

.pk-error {
  margin: 0;
  font-size: 13px;
  color: var(--wb-danger);
}

/* 空态：面板化，避免"一段灰字飘在大片空白中央" */
.pk-empty {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
}

/* ───────────────────────── 厂家筛选标签 ───────────────────────── */

.pk-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pk-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 12px;
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  background: var(--wb-surface);
  color: var(--wb-text-muted);
  font-size: 13px;
  line-height: 22px;
  cursor: pointer;
}

.pk-tab:hover {
  border-color: var(--wb-border-strong);
}

.pk-tab b {
  font-weight: 600;
  color: var(--wb-text);
  font-variant-numeric: tabular-nums;
}

.pk-tab.is-on {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
  background: var(--wb-primary-soft);
}

.pk-tab.is-on b {
  color: var(--wb-primary);
}

/* ───────────────────────── 卡片网格 ───────────────────────── */

.pk-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(224px, 1fr));
  gap: 12px;
}

.pk-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
  overflow: hidden;
}

/* 已拿完 / 已忽略：调暗（还在网格里 —— "这卡处理过了"是信息，只是不再抢眼） */
.pk-card.is-off,
.pk-card.is-done {
  opacity: 0.68;
}

/* 图区：定高 + cover —— 卡片等宽等高，网格才是"货架"而不是"瀑布" */
.pk-card__imgs {
  position: relative;
  height: 148px;
  background: var(--wb-surface-2);
}

.pk-card__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.pk-card__noimg {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 12px;
  color: var(--wb-text-muted);
}

/* 供应商角标（压图左上）：它回答"这张卡是发给哪家的" */
.pk-card__sup {
  position: absolute;
  top: 8px;
  left: 8px;
  max-width: calc(100% - 16px);
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--wb-surface);
  color: var(--wb-text-muted);
  font-size: 12px;
  line-height: 18px;
  box-shadow: var(--wb-elev-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pk-card__sup.is-missing {
  background: var(--wb-warning-soft);
  color: var(--wb-text);
}

/* 尺码角标条（压图底边）：半透明底用 `--wb-overlay` 令牌（黑底白字类的固定色值受 §1.6 约束，
   这里走令牌两套主题各有取值）。 */
.pk-card__sizes {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  background: var(--wb-overlay);
}

.pk-card__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px 10px;
}

.pk-card__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.pk-card__key {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pk-card__name {
  margin: 0;
  font-size: 12px;
  color: var(--wb-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pk-card__foot {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
}

.pk-card__amount {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* `—`（没查到价）按次要文字处理：它不是金额，不该和金额一样抢眼 */
.pk-card__amount.is-none {
  font-size: 13px;
  font-weight: 400;
  color: var(--wb-text-muted);
}

.pk-card__unit {
  font-size: 12px;
  color: var(--wb-text-muted);
  font-variant-numeric: tabular-nums;
}

.pk-card__spacer {
  flex: 1 1 auto;
}

/* 尺码角标（卡上图底条内）：`L×2` = 还要拿 2 件；`L✓` = 已拿完 */
.pk-chip {
  padding: 0 6px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  font-size: 12px;
  line-height: 18px;
  color: var(--wb-text);
  font-variant-numeric: tabular-nums;
}

/* 已拿完的码：还在格里（"这码处理过了"是信息），但不再抢眼 */
.pk-chip.is-done {
  color: var(--wb-text-muted);
}

/* 已忽略的整款色：划掉 —— 划掉的是"再要这些件"，不是"记错了"（数字照留着可回看） */
.pk-chip.is-off {
  color: var(--wb-text-muted);
  text-decoration: line-through;
}

.pk-ok {
  color: var(--wb-success);
  font-size: 12px;
}

/* ───────────────────────── 底部汇总条（吸底） ───────────────────────── */

/* ⚠️ 吸底（sticky）而不是随列表滚：卡片一多它就被顶到几十屏之外，而"生成拿货单"是这条链的
   下一步动作，找不到就等于没有。
   ⚠️ `margin-top: -16px` 是抵消 `.wb-page` 的 `gap:16px` —— 抵消掉那 16px 才能在吸底时
   不让卡片从缝隙里露出来（吸底元素只盖住自己的盒子）。

   ⚠️ `flex-shrink: 0`（2026-10-10 修）——**不能删**，这是"按钮时有时无"那个 bug 的修复点：
   本视图的根节点是 `.wb-page`（定高 `height:100%` 的弹性列），内容（精简条 + 标签 + 卡片网格 +
   汇总条）超过可用高度时，弹性布局会压缩**默认可缩**的项；而本元素自己的 `overflow: hidden`
   把自动最小尺寸（min-height:auto）归零 ⇒ 它会被一路压到 **2px**，然后自己的 overflow 再把
   行与按钮**裁掉**（DOM 里还在、`elementFromPoint` 点不到）。用户看到的症状是"按钮跟页签走"：
   全部 6 款色 / 集雨 4 款色 ⇒ 压塌最狠、两个按钮都不见；欢喜 / 大众只有 1 款色 ⇒ 压得浅、
   按钮露出来 —— 其实按钮跟页签**无关**（见模板里的 v-if 判据），只跟"这一屏放不放得下"有关。
   修复语义：条子不许缩，内容装不下就让它溢出 `.pk-view` 去滚（那才是本来的设计），
   sticky 负责把**完整的**条子钉在滚动口底边。 */
.pk-sum {
  position: sticky;
  bottom: 0;
  z-index: 2;
  flex-shrink: 0;
  margin-top: -16px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-2);
  overflow: hidden;
}

.pk-sum-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 8px 12px;
  font-size: 13px;
}

/* 分隔线画在**后续行**的顶边：首行不需要线，末行也不需要（总账那格自带一条） */
.pk-sum-row + .pk-sum-row {
  border-top: 1px solid var(--wb-border);
}

/* 未指定厂家：这一行的货要能看到，但要看得出来"还没归属" */
.pk-sum-row.is-missing {
  background: var(--wb-warning-soft);
}

.pk-sum-row__name {
  font-weight: 600;
}

.pk-sum-row__meta {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.pk-sum-row__hint {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.pk-sum-row__spacer {
  flex: 1 1 auto;
}

/* 总账：待拿 N 款色 · N 件 · 预估 ¥ —— 全页最重要的三个数，压在汇总条最后一行 */
.pk-sum__total {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 9px 12px;
  border-top: 1px solid var(--wb-border-strong);
  background: var(--wb-surface-2);
  font-size: 13px;
}

.pk-metric {
  color: var(--wb-text-muted);
}

.pk-metric b {
  font-weight: 600;
  color: var(--wb-text);
  font-variant-numeric: tabular-nums;
}
</style>
