<template>
  <div class="wb-page td-view">
    <!-- 采集状态条（T2-3，2026-11-01）—— **必须排在数字上面**。
         数字再准，若同步没成功（登录过期 / 扩展没装 / 抓 0 条但芒果说有 12 单），
         用户看到的是"今天 0 单"而不是"没抓到" —— 那正是这个条要消灭的歧义：
         两者在界面上长得一模一样，而要做的事完全不同（一个去发货，一个去重新登录）。
         ⚠️ 它是**唯一**把"没同步过"与"读不到日志"分开的地方（见 `summary.sync.error`）。 -->
    <p class="td-sync" :class="syncTone" data-act="sync-bar">
      <span class="td-sync__dot" aria-hidden="true"></span>
      <span data-act="sync-text">{{ syncText }}</span>
      <span v-if="banner.partial" class="td-sync__tag" data-act="sync-partial">
        抓取被截断
      </span>
    </p>

    <!-- 总览 = **一块四格数字**（2026-10-22 用户裁定：原先的流程卡 + 订单/待拣/缺口三张卡"暂时没什么意义"）。
         这一屏只回答一个问题：今天的货发到什么程度了 —— 要发几单 / 共几件 / 拿了多少 / 还差多少。
         ⚠️ 四个数字**都来自容器那一份汇总**（`summary.daily`），本面板一个 ipc 都不调：
            "这页说 21 件、那页说 16 行"这类缝，根因就是各页各取一份数。
         ⚠️ 算法在 `@/lib/dailyShip`（纯函数）—— 面板只摆放，不做四则运算。
         ⚠️ 断言钉在 `data-act` 上（`daily-summary` / `stat-orders` / `stat-pieces` / `stat-taken`
            / `stat-remaining` / `daily-scope`），**不按整段文本匹配**：文案会改，锚点不该跟着改。 -->
    <section class="td-daily td-daily--quiet" data-act="daily-summary">
      <header class="td-daily__head">
        <!-- 2026-11-05：标题从「今天要发」改成「今天进来」。
             它原来的名字在回答"今天要发几单"，而下面那块（跨天全量）才是这个问题的答案 ——
             两块同叫"要发"、数字还不同（2 vs 3），用户得读两行小字才敢决定信哪个。
             改名后这一块只说"今天这批进来了多少"（服务第 1-2 步的口径核对），
             首屏的"要发多少"只剩下面那一组数字。 -->
        <h2 class="td-daily__title">今天进来</h2>
        <!-- 口径小字只跟**数字**走：空态那句「今天还没有导入订单」自己已经交代了范围，
             两行一起出现就是把同件事说两遍。 -->
        <span v-if="daily.orders" class="td-daily__scope" data-act="daily-scope">
          今天导入的订单 · 不含已关闭/已完成
        </span>
      </header>

      <template v-if="daily.orders">
        <div class="td-daily__stats">
          <div class="td-stat" data-act="stat-orders">
            <span class="td-stat__num">{{ daily.orders }}</span>
            <span class="td-stat__label">单</span>
          </div>
          <div class="td-stat" data-act="stat-pieces">
            <span class="td-stat__num">{{ daily.pieces }}</span>
            <span class="td-stat__label">件商品</span>
          </div>
          <div class="td-stat" data-act="stat-taken">
            <span class="td-stat__num">{{ daily.taken }}</span>
            <span class="td-stat__label">已拿</span>
          </div>
          <div class="td-stat" :class="{ 'is-done': !daily.remaining }" data-act="stat-remaining">
            <span class="td-stat__num">{{ daily.remaining }}</span>
            <span class="td-stat__label">还差</span>
          </div>
        </div>

        <!-- 进度条：已拿 / 总件数。数字之外给一眼可见的"还剩多少"，
             但**只在有件数时出现**（0 件时那条空槽反而像"加载失败"）。 -->
        <div class="td-daily__bar" data-act="daily-bar" :title="`已拿 ${daily.taken} / 共 ${daily.pieces} 件`">
          <span
            class="td-daily__fill"
            :class="{ 'is-done': !daily.remaining }"
            :style="{ width: percent + '%' }"
          ></span>
        </div>
        <p class="td-daily__note" data-act="daily-note">
          <template v-if="!daily.remaining">全部拿齐了，可以发货</template>
          <template v-else>已拿 {{ daily.taken }} 件，还差 {{ daily.remaining }} 件</template>
        </p>
        <!-- 「已拿」里混进了"无归属台账"（2026-10-22）：加 `order_item_id` 之前的拿货单
             没记订单归属，那部分只能按款色码总量摊。这是推定，不是事实 —— 必须说出来，
             否则用户会拿这个数当逐单结论（"这件明明拿了"）。 -->
        <p v-if="daily.estimated" class="td-daily__hint" data-act="daily-estimated">
          已拿里有历史拿货单（没记订单归属），按款色总量估算
        </p>

        <!-- ⚠️ 2026-11-05：主按钮「按此开始发货」**搬到下面「现在要发」那一块**了。
             为什么：这一块已经降级成"今天进来多少"的口径说明，而"开始发货"回答的是
             "现在还有几单要发" —— 按钮跟着它服务的那组数字走，别留在已经改名的那一块里
             （否则用户点的是"今天进来"上的按钮，落到的却是跨天全量的清单）。
             本屏仍然只有一个实心按钮（`today:ui` 钉着），只是换了位置。 -->
      </template>

      <!-- 空态：这句话本身已经交代了范围（"今天"），所以不再挂口径小字。
           ⚠️ 措辞是「今天还没有订单」而不是「还没有订单数据」：库里可能明明有前几天的单，
              说"没有数据"是假话（用户会以为数据丢了）。
           ⚠️ 2026-11-02：主入口改成**芒果采集**（用户："以芒果采集为主，弱化 Excel 导入"）——
              主按钮是「去芒果采集」，Excel 退成次级 ghost 按钮。 -->
      <template v-else>
        <p class="td-daily__empty" data-act="daily-empty">今天还没有订单</p>
        <p class="td-daily__note">
          主入口：打开芒果店长的待发货页面，扩展会自动抓一次 · 备选：Excel 导入（订单报表 / 结算明细 / 报价单自动识别）
        </p>
        <!-- 主操作是采集；次操作是 Excel（弱化为 ghost）。
             ⚠️ Excel 按钮仍走容器的 `importExcel()`：切到「待发货」页签**并一步直达选文件**
                （只切页签还要用户再找一个按钮 = 白改）。 -->
        <div class="td-daily__actions">
          <button
            class="wb-btn wb-btn--primary td-daily__cta"
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
        </div>
      </template>
    </section>

    <!-- 「现在还有多少没发」（2026-11-01 T2-2 新增）—— 与上面「今天要发」**不是同一批**，
         所以是独立一块而不是第五格：
           · 上面按**导入日**筛（今天导的这批，服务导入/归类两步）；
           · 这里按**当前状态**算（全部还没发的，跨天 —— 昨天没发完的今天还在）。
         把两者并进一行会出现"待发货 0 但今天要发 12 单"这种自相矛盾的画面。
         ⚠️ 数字全部来自 `summary.pulse`（容器算），本面板一个 ipc 都不调；
            算法在 `@/lib/shippingPulse`（纯函数，vitest 覆盖）。 -->
    <section class="td-pulse" data-act="pulse-summary">
      <header class="td-pulse__head">
        <!-- 2026-11-05：从「现在还没发」改成「现在要发」——
             它是首屏**唯一**回答"我还有几单要发"的那组数字（上面那块已降级成口径说明），
             标题就该用用户的原话。 -->
        <h2 class="td-pulse__title">现在要发</h2>
        <span class="td-pulse__scope" data-act="pulse-scope">全部待发货 · 跨天</span>
      </header>

      <template v-if="pulse.pending">
        <div class="td-pulse__stats">
          <div class="td-stat td-pulse__stat" data-act="stat-pending">
            <span class="td-stat__num">{{ pulse.pending }}</span>
            <span class="td-stat__label">单待发货</span>
          </div>
          <!-- 「快超时」是要立刻处理的那一格：>0 才染警示色。
               口径 = 24h 内到截止**或已过期**（越紧急越要提醒，不能因为在过去就排除）。 -->
          <div
            class="td-stat td-pulse__stat"
            :class="{ 'is-warn': pulse.risk > 0 }"
            data-act="stat-risk"
          >
            <span class="td-stat__num">{{ pulse.risk }}</span>
            <span class="td-stat__label">单快超时</span>
          </div>
          <div class="td-stat td-pulse__stat" data-act="stat-pulse-pieces">
            <span class="td-stat__num">{{ pulse.pieces }}</span>
            <span class="td-stat__label">件商品</span>
          </div>
          <div
            class="td-stat td-pulse__stat"
            :class="{ 'is-warn': pulse.missingImage > 0 }"
            data-act="stat-missing-image"
          >
            <span class="td-stat__num">{{ pulse.missingImage }}</span>
            <span class="td-stat__label">行缺图</span>
          </div>
        </div>

        <!-- 「算不出风险」必须说出来：导入单根本没有截止期这一列，
             不说的话「快超时 0」会被读成"都不会超时"。 -->
        <p v-if="pulse.noDeadline" class="td-pulse__hint" data-act="pulse-nodeadline">
          其中 {{ pulse.noDeadline }} 单没有截止期（导入单没有这一列），算不出会不会超时
        </p>
        <p v-if="pulse.assumedQty" class="td-pulse__hint" data-act="pulse-assumed">
          件数里有 {{ pulse.assumedQty }} 行不知道数量，按 1 件计
        </p>

        <!-- 主操作区（2026-11-05 从上面「今天进来」那块搬来）：
             实心「按此开始发货」= 本屏唯一焦点，落到第 1 步；
             描边「看是哪几单」= 同一落点的下钻（`today:ui` 钉着它必须存在且真的切页签）。
             两个按钮落点相同是刻意的：一个说"开工"，一个说"先看看是哪几单"，
             用户按自己的确定程度挑一个，不必先去读清单的列名。 -->
        <div class="td-daily__actions">
          <button
            class="wb-btn wb-btn--primary td-daily__cta"
            type="button"
            data-act="daily-start"
            title="从第 1 步「待发货」开始：按最晚发货时间排好的单都在那一屏，逐单处理"
            @click="go('queue')"
          >
            按此开始发货
          </button>
          <button class="wb-btn td-pulse__cta" data-act="pulse-goto-queue" @click="go('queue')">
            看是哪几单
          </button>
        </div>
      </template>

      <!-- 空态（T2-5）：这里**必须分两种处境**，因为 0 的含义不止一个 ——
            ① 还没同步过 ⇒ 数字 0 不代表没生意，要去把单抓回来（给按钮，直达芒果待发货页）；
            ② 同步过、芒果那边就是空的 ⇒ 真没单，给一句排查指引（登录过期/扩展没生效都在状态条里说）。
           混成一句"或还没同步过"，用户既不知道该做什么，也没法判断要不要担心。
           ⚠️ 不许说"今天没有订单"：用户库里可能有前几天的单，而且今天的单可能还没被抓回来。 -->
      <div v-else class="td-pulse__empty" data-act="pulse-empty">
        <p class="td-pulse__empty-main">
          <template v-if="neverSynced">
            还没同步过 —— 打开芒果店长的待发货页面，扩展会自动抓一次
          </template>
          <template v-else>芒果那边待发货是空的（确实没有要发的单）</template>
        </p>
        <button
          v-if="neverSynced"
          class="wb-btn wb-btn--primary td-pulse__cta"
          data-act="pulse-open-mango"
          @click="onOpenMango"
        >
          打开芒果待发货页面
        </button>
        <p v-else class="td-pulse__empty-hint">
          若芒果上明明有单，看上面那条状态条：登录过期 / 扩展没生效 / 抓取被截断都会在那里说
        </p>
      </div>
    </section>

    <!-- 收尾（2026-11-05）：四步全完成才出现，不加图标、不放按钮 ——
         它只需要告诉用户"今天到此为止"，多说一句都会变成要维护的文案。 -->
    <p v-if="allDone" class="td-done" data-act="daily-done">
      今天这条流程走完了：单清完、货拿齐、账已结清
    </p>
  </div>
</template>

<script setup lang="ts">
// 「总览」页签（2026-10-22 重做）：只留四格数字 —— 今天要发多少单 / 多少件 / 已拿 / 还差。
//
// 撤掉的东西与理由（别再照着旧版加回来）：
//   · 流程卡（四步主线）：页签栏本身已经按 1-2-3-4 排好且带「当前步」标记，
//     卡片只是把同一件事讲第二遍，还占掉首屏一半高度；
//   · 订单卡 / 待拣卡 / 钱算得准吗：三张卡各说一件事，但用户每天要的是**一行数**，
//     不是三段需要逐条读的说明。「待拣」的细节在「拿货」页签、「钱」在「统计」页，
//     这里只留"发到哪一步了"。
// ⚠️ 数据全部从容器注入（`useShipping()`），本面板**自己一个 ipc 都不调**
//    （"这页说 21 件、那页说 16 行"这类缝，根因就是各页各取一份数）。
import { computed } from 'vue';
import { isNeverSynced, syncBanner } from '@/lib/syncBanner';
import { openMangoPending } from '../mangoOpen';
import { useShipping } from '../flowCtx';

const { summary, flow, go, importing, importExcel } = useShipping();

const daily = computed(() => summary.value.daily);
/** 「现在还没发」四数（容器里的 `@/lib/shippingPulse` 算好，这里只摆放） */
const pulse = computed(() => summary.value.pulse);

/**
 * 今天这条线走完了（2026-11-05）。
 *
 * 为什么要有：四步全 `done` 之后，这一屏**一点变化都没有** —— 只有页签左侧那条 3px 标记
 * 悄悄移到最后一步。用户干完一天的活，界面不说一句"完了"，第二天回来也不知道昨天是收尾了
 * 还是漏了一步。判据直接用容器的 `flow`（与页签标记同一份推导），不另算一套。
 */
const allDone = computed(
  () => flow.value.length > 0 && flow.value.every((s) => s.state === 'done'),
);

/**
 * 采集状态条（T2-3）。文案与配色**都在 `@/lib/syncBanner`**（纯函数，vitest 覆盖四种形态）——
 * 这里只把结果摆进模板，不再算第二遍。
 *
 * 为什么抽出去：四种形态若都在这一页验，UI 冒烟要连点五次刷新，实测把虚拟时间预算撑爆，
 * 断言脚本没跑完页面就被 dump 了（症状是输出截断、`grep FAIL` 一条都没有，看着像全绿）。
 */
const sync = computed(() => summary.value.sync);

/** 三种形态的文案与染色都在纯函数里（四态各有单测），这里只摆放 */
const banner = computed(() => syncBanner(sync.value));

/**
 * 「从来没同步过」（T2-5 空态）。判据在 `@/lib/syncBanner` 的 `isNeverSynced` ——
 * 清单页签用的是同一个函数：同一个 0 在两屏上说两种话，用户就没法相信任何一个。
 */
const neverSynced = computed(() => isNeverSynced(sync.value));

/** 模板里要的三样：文案 / 配色档位 / 是否带"抓取被截断"标签 */
const syncText = computed(() => banner.value.text);
const syncTone = computed(() => `is-${banner.value.tone}`);

/** 已拿占比（0~100）。件数为 0 时进度条不渲染，这里只在有件数时被用到 */
const percent = computed(() => {
  const { pieces, taken } = daily.value;
  if (!(pieces > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((taken / pieces) * 100)));
});

/** 空态的「Excel 导入」：切到「待发货」页签**并立刻弹选文件**（一步直达，不让用户再找一次按钮） */
function onEmptyImport(): void {
  go('queue');
  void importExcel();
}

/**
 * 空态的「打开芒果待发货页面」（T2-5）：把"该怎么开始"变成一次点击。
 * 失败由 `openMangoPending` 自己 toast（这一步失败的唯一表现就是"没反应"，必须给原因）。
 */
function onOpenMango(): void {
  void openMangoPending();
}
</script>

<style scoped>
/* 采集状态条（T2-3）：一行小字 + 一个状态点。
   刻意做得**轻**（不加卡片、不加边框）：它是背景信息，不是主角；
   但失败时整条染色 + 状态点变红，足够让人一眼看到 —— 因为它挡的是"以为今天没单"。
   配色一律用语义变量（`--wb-danger` 等），不写死色值：浅色/深色主题下都要能读。 */
.td-sync {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 2px;
  padding: 7px 10px;
  border-radius: var(--wb-radius);
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-text-muted);
  /* `--wb-surface-2` 是"比卡片再退一层"的底色（浅色/深色主题各有定义）；
     早期这里写过一个不存在的 `--wb-surface-sunken`，fallback 会生效但等于悄悄绕过主题 */
  background: var(--wb-surface-2);
}

.td-sync__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.75;
}

/* 正常：安静 */
.td-sync.is-ok {
  color: var(--wb-text-muted);
}

.td-sync.is-ok .td-sync__dot {
  background: var(--wb-success);
  opacity: 1;
}

/* 从没同步过：不是错误，但要知道怎么开始 —— 用中性偏提示的色，别用红 */
.td-sync.is-idle {
  color: var(--wb-text-muted);
}

.td-sync.is-idle .td-sync__dot {
  background: var(--wb-warning);
  opacity: 1;
}

/* 抓取被截断：数据能用但不全 */
.td-sync.is-warn {
  color: var(--wb-warning);
  background: color-mix(in srgb, var(--wb-warning) 10%, transparent);
}

/* 失败 / 读不到：整条染色（文字也染色，避免"只有小圆点变色"的半截感） */
.td-sync.is-error {
  color: var(--wb-danger);
  background: color-mix(in srgb, var(--wb-danger) 10%, transparent);
}

.td-sync__tag {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 11px;
  line-height: 16px;
}

/* 一行四格：窄窗自动折成两行（`auto-fit` + 132px 下限），不硬挤成四列把数字压扁 */
.td-daily {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px 20px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
}

/* 「今天进来」= **口径说明**，不是首屏主角（2026-11-05）。
   降权手段只用三样、一个新颜色都不加：退到次级表面 / 去掉投影 / 数字小一号。
   ⚠️ 不要把它做得"更漂亮"——这一块与下面「现在要发」是**两级信息**，
      两块一样重的话，"今天要发几单"又变成两个答案（这正是要修的那个问题）。 */
.td-daily--quiet {
  padding: 14px 18px 16px;
  background: var(--wb-surface-2);
  box-shadow: none;
}

.td-daily--quiet .td-stat__num {
  font-size: 22px;
  font-weight: 600;
}

.td-daily--quiet .td-stat {
  border-left-color: var(--wb-border);
}

/* 降权块里「还差」不再染警示色：警示色属于"现在要发"那一组，
   这里再染一次就等于两次提醒同一件事，且会让次级块抢回视觉焦点。 */
.td-daily--quiet .td-stat:last-child .td-stat__num,
.td-daily--quiet .td-stat.is-done .td-stat__num {
  color: var(--wb-text);
}

.td-daily--quiet .td-stat:last-child {
  border-left-color: var(--wb-border);
}

.td-daily__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.td-daily__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text);
}

/* 口径小字：数字的作用域。写在标题右边、同一行 —— 与数字分开读就会变成"库里一共这么多" */
.td-daily__scope {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.td-daily__stats {
  display: grid;
  /* 四格并排，但**限宽**：满窗铺开时两格之间会拉开一大片空白，
     "一格数"就被读成"四个互不相关的数"。限宽后它们是一个整体。 */
  max-width: 720px;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 10px;
}

/* 一格一个数：大数字 + 小标签，无边框无底色（"简洁明了"靠留白与字号层级，不靠卡片套卡片） */
.td-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-right: 10px;
  border-left: 2px solid var(--wb-border);
  padding-left: 12px;
}

.td-stat__num {
  font-size: 30px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.02em;
  color: var(--wb-text);
  /* 等宽数字：切换数据时不跳位 */
  font-variant-numeric: tabular-nums;
}

.td-stat__label {
  font-size: 12px;
  color: var(--wb-text-muted);
}

/* 「还差」是要动手的那一个数：> 0 时用警示色（左侧竖条一起染，避免"只有数字变色"的半截感） */
.td-stat:last-child .td-stat__num {
  color: var(--wb-warning);
}

.td-stat:last-child {
  border-left-color: var(--wb-warning);
}

/* 拿齐了 → 回归普通色（红色数字挂在那里会让人以为还有活没干） */
.td-stat.is-done .td-stat__num {
  color: var(--wb-success);
}

/* ---- 「现在还没发」第二块（T2-2）---------------------------------------------
   与上面同一套格子样式（复用 `.td-stat`），但要**解掉上面那条 `:last-child` 规则**：
   那条是为「还差」写的，在这里会把"行缺图"无条件染红 —— 缺图是常态（导入单没图），
   常态染红等于没有警示。这里改成「只在 `is-warn` 时染色」，由数据决定。 */
.td-pulse {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px 20px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
}

.td-pulse__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
}

.td-pulse__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text);
}

.td-pulse__scope {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.td-pulse__stats {
  display: grid;
  max-width: 720px;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 10px;
}

/* 复位上面为「还差」写的 last-child 染色 */
.td-pulse .td-stat:last-child .td-stat__num {
  color: var(--wb-text);
}

.td-pulse .td-stat:last-child {
  border-left-color: var(--wb-border);
}

/* 只在真有风险/真缺图时染色（数字与左侧竖条一起染，避免半截感） */
.td-pulse .td-stat.is-warn .td-stat__num {
  color: var(--wb-warning);
}

.td-pulse .td-stat.is-warn {
  border-left-color: var(--wb-warning);
}

.td-pulse__hint {
  margin: 0;
  font-size: 12px;
  color: var(--wb-text-muted);
}

.td-pulse__empty {
  margin: 0;
  font-size: 13px;
  color: var(--wb-text-muted);
}

/* 下钻按钮跟内容宽度，不铺满（铺满会变成"整块只有一个按钮"） */
.td-pulse__cta {
  align-self: flex-start;
}

/* 空态两段：主句说"哪种没有"，副句/按钮说"接下来做什么" */
.td-pulse__empty-main {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--wb-text);
}

.td-pulse__empty-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}

.td-stat.is-done {
  border-left-color: var(--wb-success);
}

/* 进度条：细，不抢数字。**轨道用边框色**而不是 surface-2 —— 次级表面几乎与白底同色，
   轨道看不见时"已拿多长"就只剩一截悬空的线，读不出比例（深色主题下尤其明显）。 */
.td-daily__bar {
  height: 6px;
  border-radius: 999px;
  background: var(--wb-border);
  overflow: hidden;
}

.td-daily__fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--wb-primary);
  transition: width 0.2s ease;
}

.td-daily__fill.is-done {
  background: var(--wb-success);
}

/* 尊重「减少动效」：系统开了这个偏好就别让条子滑 */
@media (prefers-reduced-motion: reduce) {
  .td-daily__fill {
    transition: none;
  }
}

.td-daily__note {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-text-muted);
}

/* 「按估算」那句：比主小字更弱一档，但**不能省** —— 它是这个数字的可信度声明。
   用虚线左边框 + 同色系，避免看起来像一条新的错误提示。 */
.td-daily__hint {
  margin: 0;
  padding-left: 8px;
  border-left: 2px dashed var(--wb-border);
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-text-muted);
}

.td-daily__empty {
  margin: 0;
  font-size: 15px;
  color: var(--wb-text-muted);
}

/* 按钮跟着内容宽度，不铺满整行（铺满会变成"整页只有一个按钮"的压迫感）。
   2026-11-02：主（采集）+ 次（Excel）并排 —— 次要按钮自己不来抢主按钮的宽度。 */
.td-daily__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.td-daily__cta {
  align-self: flex-start;
}

/* 收尾一句：安静的绿，不抢"现在要发"那组数字；没有背景块 —— 它是一条状态，不是一张卡 */
.td-done {
  margin: 0;
  padding: 2px 2px 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--wb-success);
}
</style>
