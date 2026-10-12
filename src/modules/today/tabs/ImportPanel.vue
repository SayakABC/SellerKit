<template>
  <div class="wb-page td-import">
    <!-- ── 投放区（本页的主入口）───────────────────────────────────────────────
         两个动作合成一个视觉块，用户不用先想"我该点哪"：
           · 点**整块**（不限于那个按钮）→ 拉起选文件对话框；
           · 把文件**拖到块里**（松手即导入）—— 导 Excel 最常见的动作就是"从资源管理器拖过来"。
         ⚠️ 点击 handler **只挂在区块上，按钮自己不挂**：按钮的 click 会冒泡上来触发它。
            两个 handler 并存时一次点击会导入两次，而导入**不是幂等**的（同一份订单报表导两遍
            = 订单行翻倍），所以从结构上只留一条路径，而不是靠"记得写 stopPropagation"。
         ⚠️ `data-act="import"` 仍在**按钮**上：既有断言点它，也靠它的 `disabled` 判"导入中"。
         ⚠️ 拖拽的 enter/leave 在子元素之间会反复触发 ⇒ 用计数器判定，"进出子元素"不算离开，
            否则指针划过图标/按钮时高亮会闪。 -->
    <div
      class="ti-drop"
      :class="{ 'is-over': isOver, 'is-busy': importing }"
      data-act="import-drop"
      @click="pick"
      @dragenter.prevent="onEnter"
      @dragover.prevent
      @dragleave.prevent="onLeave"
      @drop.prevent="onDrop"
    >
      <span class="ti-drop__ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M12 16V4" stroke-linecap="round" />
          <path d="m7 9 5-5 5 5" stroke-linecap="round" stroke-linejoin="round" />
          <path
            d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>

      <!-- ⚠️ 这里**只有标题一行文字**（2026-10-11 二次收口）：原先还有一行副标题
           （"点这块任意位置选文件，也可以直接把文件拖进来"）—— 它说的两件事，界面自己已经说完了：
           按钮 = 点击入口，虚线框 + 上传图标 = 可投放。**能靠形状说清的就不要再写一句。** -->
      <p class="ti-drop__title">{{ dropTitle }}</p>

      <button
        class="wb-btn wb-btn--primary ti-drop__btn"
        type="button"
        data-act="import"
        :disabled="importing"
      >
        <span v-if="importing" class="ti-spin" aria-hidden="true"></span>
        {{ importing ? '导入中…' : '选择 Excel 文件' }}
      </button>

      <!-- 能识别的四类：**不是说明文字而是能力清单** —— 用户得先知道"我手上这份算不算数"。
           原先它埋在空态那句长括号里（"（订单报表 / 待发货订单 / 结算明细 / 报价单）"），扫不动。 -->
      <ul class="ti-drop__types" aria-label="能自动识别的文件类型">
        <li v-for="t in TYPES" :key="t">{{ t }}</li>
      </ul>
    </div>

    <!-- 库里现状：导完/刷新后一眼知道"今天导进来几行、这行从哪来、最近哪天"。
         ⚠️ 口径 2026-10-11：这个数跟着**发货台**走（`summary.orders` 按导入日筛）⇒ 是
            **今天**导进来的行数，不是全库。所以抬头从「库里现有」改成「今天导入」——
            不改的话下面那个数字会被读成"库里一共这么多"（而全库的数这里看不到，
            要问全库请去独立模块「算钱」）。空态也不回避：今天没导就明说「0 行订单」。 -->
    <div class="ti-stock" data-act="import-stock">
      <span class="ti-stock__lead">今天导入</span>
      <span class="ti-stock__big">{{ orders.total }}<em>行订单</em></span>
      <span class="ti-stock__sep" aria-hidden="true"></span>
      <span class="ti-stock__kv">报表 <b>{{ orders.import }}</b></span>
      <span class="ti-stock__kv">采集 <b>{{ orders.collect }}</b></span>
      <span v-if="orders.lastTime" class="ti-stock__kv">最近下单 <b>{{ orders.lastTime }}</b></span>
    </div>

    <!-- 上次导入的回执 = **结论卡**（2026-10-11 重做）。
         用户实报「导完记录不知道去哪了、反馈信息模糊、文字太多、完全看不懂」—— 病根是这一张卡
         把**结论 / 落点 / 按钮 / 判据**四样东西用同一档字号平铺，而最长的那段判据（识别凭什么、
         拆了几行、主图成没成）排在中间：用户得整段读完才知道结果，甚至读完了也只知道"发生了什么"
         而不知道"我接下来点哪"。
         现在的层次（自上而下 = 用户关心的顺序）：
           ① 标题 —— 这是什么文件（含子类，如"芒果店长待发货订单"）
           ② `headline` —— **大字结论**："已导入 12 行订单"
           ③ `landed`  —— 一句小字回答"存哪了、去哪能看到"
           ④ `warnings` —— **只有真出事才出现**（跳过几行 / 主图没下来），平铺、不折叠
           ⑤ 下一步按钮（最多两个，主操作只有一个）
           ⑥ `message`  —— 判据，**折叠**在「怎么看出来的」里（出问题才展开）
         ⚠️ `data-act` 名沿用（`import-result` / `import-title` / `import-landed` / `import-next` /
            `import-next-<key>` / `import-detail` / `import-dismiss`）：既有断言原样重挂。
           新增的是 `import-headline` / `import-warn`（判据挂在可折叠的 `<details>` 上）。
         ⚠️ `import-detail` 现在在 `<details>` **里面**：`textContent` 仍然读得到（折叠 ≠ 移除），
            所以"判据里写了什么"那几条断言不受影响；**另加一条**断言它默认是收起的、点开能展开
            （否则"折叠"只写在样式上，用户根本看不到展开的办法）。 -->
    <div
      v-if="receipt"
      class="td-receipt"
      :class="{ 'td-receipt--nowrite': !receipt.wrote }"
      data-act="import-result"
    >
      <div class="td-receipt__head">
        <span
          class="td-receipt__badge"
          :class="receipt.wrote ? 'is-ok' : 'is-warn'"
          >{{ receipt.wrote ? '已导入' : '未写入' }}</span
        >
        <span class="td-receipt__title" data-act="import-title">{{ receipt.title }}</span>
        <button
          class="wb-btn wb-btn--sm wb-btn--ghost td-receipt__close"
          type="button"
          data-act="import-dismiss"
          title="关掉这条回执"
          aria-label="关掉这条回执"
          @click="dismiss"
        >
          ×
        </button>
      </div>

      <!-- ② 大字结论：用户扫一眼就该知道"这次成了没有、成了多少" -->
      <p class="td-receipt__headline" data-act="import-headline">{{ receipt.headline }}</p>

      <!-- ③ 落点：回答"数据去哪了"。① 只给**人话名**（订单 / 结算明细 / 运价表），
             ② 列出去哪能看到它；③ 不写库时（`landed === null`）整句不出现。 -->
      <p v-if="receipt.landed" class="td-receipt__landed" data-act="import-landed">
        存到「{{ receipt.landed.label }}」—— 在 {{ receipt.landed.views.join('、') }} 能看到
      </p>

      <!-- ④ 异常行：**只有真的出事才出现**（`warnings` 为空时这一块整块不渲染）。
             它跟下面的"判据"不同：这些是用户**要采取行动**的事（回去补报表 / 知道这几行没图），
             所以平铺、不上折叠。 -->
      <ul v-if="receipt.warnings.length" class="td-receipt__warn" data-act="import-warn">
        <li v-for="w in receipt.warnings" :key="w">{{ w }}</li>
      </ul>

      <!-- ⑤ 下一步：主操作最多一个（primary） -->
      <div v-if="receipt.next.length" class="td-receipt__next" data-act="import-next">
        <span class="td-receipt__nextlabel">下一步</span>
        <button
          v-for="a in receipt.next"
          :key="a.tab || a.moduleId || a.label"
          class="wb-btn"
          :class="{ 'wb-btn--primary': a.primary }"
          type="button"
          :data-act="`import-next-${a.tab || a.moduleId}`"
          @click="nextGo(a)"
        >
          {{ a.label }}
        </button>
      </div>

      <!-- ⑥ 判据（识别凭什么、拆了几行、主图成没成…）—— **默认折叠**。
             原先它平铺在卡片中间，是"文字太多、看不懂"的主要来源；现在出问题时才展开。 -->
      <details class="td-receipt__more">
        <summary data-act="import-detail-toggle">怎么看出来的</summary>
        <p class="td-receipt__detail" data-act="import-detail">{{ receipt.message }}</p>
      </details>
    </div>

    <!-- ⚠️ 回执的下方**刻意什么都没有**（2026-10-11 二次收口）：
         这里原本挂着一张"预告卡"（`data-act="import-none"`，写着"导入后这里会留下一张回执"）——
         那是**一段解释自己的说明文字**：它占着位置、每次导入前都要读一遍，而它想说的那件事
         用户点一次就知道了。空态本来就该是**入口本身**（上面的投放区），而不是另一块文字。
         ⚠️ 连带的断言改动见 `scripts/today-ui-smoke.mjs` 的 `import-drop` 段：
            判据从"空态文案里有没有 Excel / 回执"改成"回执撤掉后入口还在、且仍可用"
            （后者才是真会坏的东西 —— 空态文案少了不影响任何人，入口没了才致命）。 -->
  </div>
</template>

<script setup lang="ts">
// 「导入订单」页签 = 发货流程第 1 步。
//
// ⚠️ **导入动作不在本组件里**：它在容器（`TodayView.vue`）—— 因为总览页签的空态按钮
//    要能"切过来并立刻弹选文件"，而拖进来的文件也要走**同一条**识别/落库链路。
//    本组件只负责**呈现与投放**（点/拖 → 交给容器的 `importExcel` / `importFile`）。
//
// 2026-10-11：整页重排 —— 单按钮 + 灰字提示 ⇒ 投放区（可点可拖）+ 类型标签 + 库内现状条 + 回执卡。
import { computed, ref } from 'vue';
import type { ImportNextStep } from '@/core/services/importSheet';
import { useShipping } from '../flowCtx';

const { summary, go, openModule, receipt, importing, importExcel, importFile } = useShipping();

const orders = computed(() => summary.value.orders);

/** 能自动识别的四类（与 `core/services/importSheet` 的识别分支一致；「商品信息」表刻意不列 —— 它不该导） */
const TYPES = ['订单报表', '待发货订单', '结算明细', '报价单'];

/** 投放区高亮：`dragenter`/`dragleave` 在子元素间来回触发 ⇒ 计数归零才算真的离开 */
const isOver = ref(false);
let depth = 0;

const dropTitle = computed(() => {
  if (isOver.value) return '松手就导入';
  if (importing.value) return '正在识别并入库…';
  return '把订单 Excel 拖到这里';
});

/** 选文件（**全页唯一的点击入口**）：按钮的 click 也冒泡到这里 —— 见模板上的注释 */
function pick(): void {
  if (importing.value) return;
  void importExcel();
}

function onEnter(): void {
  depth += 1;
  isOver.value = true;
}
function onLeave(): void {
  depth = Math.max(0, depth - 1);
  if (depth === 0) isOver.value = false;
}

/** 松手：把第一个文件交给容器。能同时拖多个也只认第一个（一份报表就是一天的量）。 */
function onDrop(e: DragEvent): void {
  depth = 0;
  isOver.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  void importFile(f);
}

/**
 * 回执里的"下一步"动作。
 *
 * ⚠️ 2026-10-11 起这一步变简单了：**绝大多数落点就是本页的一个页签**，而 `ImportNextStep.tab`
 *    把它们写明了（`classify` / `purchase` / `cost`），直接 `go(tab)` 就地切。
 *
 * 原先这里挂着一张 `TAB_OF`（把模块 id 映到页签），因为它只能拿到 `moduleId`：
 * 于是回执要发 `moduleId: 'picking'`，再由本页偷偷换成「拿货」页签 —— 两处各写一半的映射。
 * 现在**映射消失在一处**（由 `importSheet` 直接给页签 id），这张表随之删掉。
 * 剩下的唯一分支：真跳别的模块（如「货与成本」这类主数据维护页，本页没有它的页签）。
 */
function nextGo(a: ImportNextStep): void {
  if (a.tab) {
    go(a.tab);
    return;
  }
  if (a.moduleId) openModule(a.moduleId);
}

/** 关掉回执（写在容器那份 ref 上：总览的「待拣」卡靠它决定要不要点亮） */
function dismiss(): void {
  receipt.value = null;
}
</script>

<style scoped>
/* ══ 投放区 ══════════════════════════════════════════════════════════════════
   虚线框 = 约定的"可投放"语义；悬浮/拖入时变主色实线 + 浅底（**不靠背景色差**：
   深色主题下那点色差读不出来，所以边框样式本身也变）。 */
.ti-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 22px 24px 18px;
  border: 1.5px dashed var(--wb-border-strong);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
  text-align: center;
  cursor: pointer;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease;
}
.ti-drop:hover {
  border-color: var(--wb-primary);
}
.ti-drop.is-over {
  border-style: solid;
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
/* 键盘走到里面的按钮时整块给反馈（区块自己不可聚焦，靠 :focus-within 代偿） */
.ti-drop:focus-within {
  border-color: var(--wb-primary);
  box-shadow: 0 0 0 3px var(--wb-focus-ring);
}
.ti-drop.is-busy {
  cursor: progress;
}

.ti-drop__ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}
.ti-drop__ico svg {
  width: 22px;
  height: 22px;
}
.ti-drop:hover .ti-drop__ico,
.ti-drop.is-over .ti-drop__ico {
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
}

.ti-drop__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--wb-text);
}
.ti-drop__btn {
  margin-top: 2px;
  height: 32px;
  padding: 0 1rem;
  font-size: 13px;
}

/* 加载指示：只用 transform 动画（GPU），并尊重"减少动效"偏好 */
.ti-spin {
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: ti-spin 0.7s linear infinite;
}
@keyframes ti-spin {
  to {
    transform: rotate(360deg);
  }
}

.ti-drop__types {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
.ti-drop__types li {
  padding: 2px 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--wb-text-muted);
}

/* ══ 库内现状 ═════════════════════════════════════════════════════════════ */
.ti-stock {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 14px;
  padding: 10px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  font-size: 12.5px;
  color: var(--wb-text-muted);
}
.ti-stock__lead {
  font-weight: 600;
  color: var(--wb-text);
}
.ti-stock__big {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--wb-text);
  font-variant-numeric: tabular-nums;
}
.ti-stock__big em {
  margin-left: 4px;
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  color: var(--wb-text-muted);
}
.ti-stock__sep {
  width: 1px;
  height: 14px;
  align-self: center;
  background: var(--wb-border);
}
.ti-stock__kv b {
  font-weight: 600;
  color: var(--wb-text);
  font-variant-numeric: tabular-nums;
}

/* ══ 导入回执 ═════════════════════════════════════════════════════════════
   一张常驻卡，回答"这是什么文件 / 数据去哪了 / 下一步点哪"。
   左侧色条区分"写库了 / 没写库"（不靠背景色差 —— 深色主题下那点色差读不出来）。 */
.td-receipt {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--wb-border);
  border-left: 3px solid var(--wb-primary);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
  /* 只动 transform/opacity（GPU 加速），0.2s —— 卡片"落下来"而不是硬闪出来 */
  animation: ti-in 0.2s ease-out both;
}
@keyframes ti-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* 未写库：warn 色条（它更该被看见 —— "什么也没发生"是容易漏掉的结果） */
.td-receipt--nowrite {
  border-left-color: var(--wb-warning);
}

.td-receipt__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.td-receipt__badge {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 11.5px;
  line-height: 1.6;
}
/* 状态色：写库了 = 成功绿，没写 = 警示橙（深色主题下这两组也达标） */
.td-receipt__badge.is-ok {
  background: var(--wb-success-soft);
  color: var(--wb-success);
}
.td-receipt__badge.is-warn {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}

.td-receipt__title {
  min-width: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--wb-text);
}

.td-receipt__close {
  margin-left: auto;
}

/* 判据明细（识别凭什么这么判 + 导了多少行）—— **压在最后当脚注**：加条分隔线降一档，
   不跟"落点 / 下一步"抢注意力（它信息量最大，但用户大多是出问题时才回头核对）。 */
.td-receipt__detail {
  margin: 0;
  padding-top: 8px;
  border-top: 1px solid var(--wb-border);
  font-size: 12px;
  line-height: 1.55;
  color: var(--wb-text-muted);
}

/* ── 结论卡的三层（2026-10-11）──────────────────────────────────────────────
   ① 大字结论：卡片里**唯一**的大字号（与卡片标题 13.5px / 正文 12.5px 拉开三档），
      扫一眼就是结果。原先没有这一层 —— 结果混在 sentence 里，得读。 */
.td-receipt__headline {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: var(--wb-text);
}

/* ④ 异常行：直接平铺（**要用户采取行动**的事，不能折叠）。
   左侧一条警示色边 + 逐条一行，与下面的判据（灰、折叠）在视觉上分得开。 */
.td-receipt__warn {
  margin: 0;
  padding: 6px 0 6px 10px;
  border-left: 2px solid var(--wb-warning);
  list-style: none;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--wb-warning);
}

/* ⑥ 判据：**默认折叠**。`<summary>` 是唯一可见的那一行 —— 它要看起来**像可点的**
   （默认的三角标记 + hover 变主色），否则用户根本不知道里面还有内容可看。 */
.td-receipt__more {
  border-top: 1px solid var(--wb-border);
  padding-top: 8px;
}
.td-receipt__more > summary {
  font-size: 12px;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.td-receipt__more > summary:hover {
  color: var(--wb-primary);
}
/* 展开后那段不该再带自己的分隔线（它上面已经是 summary 那条） */
.td-receipt__more .td-receipt__detail {
  padding-top: 6px;
  border-top: 0;
}

/* 落点：**回答"数据去哪了"**的那一行 —— 正文色，比判据重一档，但比结论轻（它是一句注释）。 */
.td-receipt__landed {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--wb-text);
}

.td-receipt__next {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.td-receipt__nextlabel {
  font-size: 12px;
  color: var(--wb-text-muted);
}

/* 「减少动效」偏好：关掉入场与旋转，不牺牲信息 */
@media (prefers-reduced-motion: reduce) {
  .td-receipt {
    animation: none;
  }
  .ti-spin {
    animation-duration: 2s;
  }
}
</style>
