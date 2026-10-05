<template>
  <div class="wb-page td-view">
    <!-- 发货主线：把「导入 → 归类 → 拣货 → 算钱 → 拿货 → 对账」六步串成一条线，回答三个问题 ——
         **我在哪一步 / 下一步做什么 / 这件事在哪个页签做**。
         改造后点任一步是**切页签**（`go(s.tab)`），不再跳走。
         状态只用容器那份汇总推导，**不在这里另取数**。
         ⚠️ 断言钉在 `data-act` 上（`flow` / `flow-<key>` / `flow-next`），不按整段文本匹配。 -->
    <section class="td-flow" data-act="flow">
      <div class="td-flow__head">
        <span class="td-flow__title">每日发货流程</span>
        <span class="td-flow__hint">点任一步就地切换页签</span>
      </div>
      <ol class="td-flow__steps">
        <li
          v-for="s in flow"
          :key="s.key"
          class="td-flow__step"
          :class="[`is-${s.state}`, { 'is-pending': s.pending }]"
          :data-act="`flow-${s.key}`"
          :title="`${s.name} —— 在${s.where}`"
          @click="go(s.tab)"
        >
          <span class="td-flow__no">第 {{ s.no }} 步</span>
          <span class="td-flow__name">{{ s.name }}</span>
          <span class="td-flow__note">{{ s.note }}</span>
          <span class="td-flow__where">{{ s.where }}</span>
        </li>
      </ol>
      <div class="td-flow__next" data-act="flow-next">
        <span class="td-flow__nexttext">下一步：<b>{{ flowNow.name }}</b> —— {{ flowNow.note }}</span>
        <button
          class="wb-btn wb-btn--primary wb-btn--sm"
          :data-act="`flow-next-${flowNow.key}`"
          @click="go(flowNow.tab)"
        >
          {{ flowNow.act }}
        </button>
      </div>
      <!-- 六步**全部**在本页页签里（2026-10-05 归位：原先这里挂着一句"后两步还在插件里"+
           一个跳去「订单归类」的按钮 —— 现在没有"在别处"的步骤了，那段话与那个按钮一并撤掉）。
           这里刻意**不再**给"去插件"的入口：留一个"要不要用插件"的岔路，和"一步都不跳"的诉求相抵。 -->
    </section>

    <div class="td-cards">
      <!-- ① 订单：有没有数据、两条通道各多少 -->
      <section class="td-card" data-act="card-orders">
        <div class="td-card__head">
          <span class="td-card__ico" v-html="ICON.orders"></span>
          <span class="td-card__title">订单</span>
        </div>

        <template v-if="orders.total">
          <div class="td-value">{{ orders.total }} <span class="td-unit">行</span></div>
          <div class="td-facts">
            <span>采集 {{ orders.collect }} 行</span>
            <span>导入 {{ orders.import }} 行</span>
            <span v-if="orders.lastTime">最近下单 {{ orders.lastTime }}</span>
          </div>
          <button class="wb-btn wb-btn--primary td-cta" data-act="go-cost" @click="go('cost')">
            看订单与利润
          </button>
        </template>

        <template v-else>
          <div class="td-value td-value--empty">还没有订单数据</div>
          <div class="td-facts td-facts--stack">
            <span>来源①：浏览器采集（自带推送）</span>
            <span
              >来源②：Excel 导入（「导入订单」页签自动识别：订单报表 / 商品信息 / 报价单 /
              结算明细）</span
            >
          </div>
          <!-- 主操作是**宿主自己能做的那一步**（宿主能直接导订单报表）：
               旧按钮「去打开「订单归类」」把用户送去装插件，而插件不装也能导入 —— 指向已过时。
               现在：切到导入页签**并一步直达选文件**（只切页签还要用户再找一个按钮 = 白改）。 -->
          <button
            class="wb-btn wb-btn--primary td-cta"
            data-act="empty-import"
            :disabled="importing"
            @click="onEmptyImport"
          >
            {{ importing ? '导入中…' : '导入 Excel' }}
          </button>
          <p class="td-hint">想做 AI 款式 / 颜色识别，去「归类核对」页签</p>
        </template>
      </section>

      <!-- ② 待拣：要发什么货（未发货 · 近 30 天，范围写在卡上） -->
      <section class="td-card" :class="{ 'is-fresh': freshOrders }" data-act="card-picking">
        <div class="td-card__head">
          <span class="td-card__ico" v-html="ICON.picking"></span>
          <span class="td-card__title">待拣</span>
        </div>

        <template v-if="picking.sku">
          <div class="td-value">{{ picking.sku }} 个 SKU · {{ picking.pieces }} 件</div>
          <div class="td-facts">
            <span>涉及订单 {{ picking.orders }}</span>
            <span>范围：未发货 · 近 {{ picking.days }} 天</span>
            <span v-if="picking.missing" class="td-warn">缺数据 {{ picking.missing }} 处</span>
          </div>
          <button class="wb-btn wb-btn--primary td-cta" data-act="go-picking" @click="go('picking')">
            生成待拣清单
          </button>
          <!-- 刚导完订单时把这张卡点亮：导入后的下一步就是它，但三张卡并列时用户得自己找
               （**只做引导不重复入口** —— 动作仍是上面那个按钮，这里不给第二个按钮） -->
          <p v-if="freshOrders" class="td-fresh" data-act="picking-fresh">
            刚导入的订单已算进来
          </p>
        </template>

        <template v-else>
          <div class="td-value td-value--empty">没有要拣的</div>
          <div class="td-facts td-facts--stack">
            <span>未发货 · 近 {{ picking.days }} 天里没有货要发</span>
          </div>
        </template>
      </section>

      <!-- ③ 钱算得准不准：只有"缺什么"的存在性检查，算法不在这页 -->
      <section class="td-card" data-act="card-gaps">
        <div class="td-card__head">
          <span class="td-card__ico" v-html="ICON.gaps"></span>
          <span class="td-card__title">钱算得准吗</span>
        </div>

        <div class="td-value" :class="{ 'td-value--empty': !gapTotal }">
          {{ gapTotal ? `还缺 ${gapTotal} 项` : '数据齐了' }}
        </div>
        <div class="td-facts">
          <span :class="{ 'td-warn': gaps.weight }">缺克重 {{ gaps.weight }} 行</span>
          <span :class="{ 'td-warn': gaps.cost }">缺成本 {{ gaps.cost }} 行</span>
          <span :class="{ 'td-warn': gaps.style }">未识别款 {{ gaps.style }} 行</span>
          <span :class="{ 'td-warn': !gaps.rate }">运价表 {{ gaps.rate ? '有' : '没有' }}</span>
        </div>
        <div class="td-actions">
          <!-- 缺克重的下一步**只有一个**：去「货与成本」按 SKU 补（2026-10-01：克重是 SKU 属性，
               商品ID 克重那条导入链已删；原来那个「导入商品信息」按钮指向的能力不存在了）。
               ⚠️ 「货与成本」是**主数据维护**、不属于这条发货流程的任何一步，所以它是真跳转
               （`openModule`），不像上面几步那样切页签 —— 别顺手统一成切页签，本页没有它的页签。 -->
          <button
            v-if="gaps.weight"
            class="wb-btn wb-btn--primary td-cta"
            data-act="go-goods"
            @click="openModule('goods')"
          >
            去「货与成本」补 SKU 克重
          </button>
          <button v-if="gapTotal" class="wb-btn td-cta" data-act="go-cost-gaps" @click="go('cost')">
            看缺在哪
          </button>
          <button
            v-if="!gaps.weight && (gaps.cost || gaps.style)"
            class="wb-btn td-cta"
            data-act="go-goods2"
            @click="openModule('goods')"
          >
            货与成本
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
// 「总览」页签：一眼看到"现在该干什么"，每块给一个可点的下一步。
//
// 与改造前的关系：内容基本照搬原「今天」页（流程卡 + 三张卡），两处改动 ——
//   ① 点步骤/按钮改成**切页签**（`go(tabId)`），不再 `switchModule` 跳走；
//   ② 数据全部从容器注入（`useShipping()`），本面板**自己一个 ipc 都不调**
//      （"这页说缺多少行、那页说不缺"这类缝，根因就是各页各取一份数）。
import { computed } from 'vue';
import { useShipping } from '../flowCtx';

const { summary, flow, flowNow, go, openModule, receipt, importing, importExcel } = useShipping();

const orders = computed(() => summary.value.orders);
const picking = computed(() => summary.value.picking);
const gaps = computed(() => summary.value.gaps);
const gapTotal = computed(() => summary.value.gapTotal);

/** 刚导进来的是订单吗（真写库了、且真有货可拣）—— 是就把「待拣」卡点亮：导入之后的下一步就是它 */
const freshOrders = computed(
  () => receipt.value?.kind === 'orders' && receipt.value.wrote && picking.value.sku > 0
);

/** 空态的「导入 Excel」：切到导入页签**并立刻弹选文件**（一步直达，不让用户再找一次按钮） */
function onEmptyImport(): void {
  go('import');
  void importExcel();
}

/** 卡片头图标（内联 SVG，跟随 currentColor；不用 emoji —— 各平台字形差异大且不可调色） */
const ICON = {
  orders:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9.5 8.5h5M9.5 12.5h5"/></svg>',
  picking:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/></svg>',
  gaps: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 21 20H3z"/><path d="M12 10.5v3.5M12 17.2h.01"/></svg>',
};
</script>

<style scoped>
/* 页面外壳（栅格 / 内边距）由全局 .wb-page 提供；这里只写本页特有布局。
   ⚠️ 所有"文字行"保持原样不动：三个 UI 冒烟脚本按 textContent 做子串断言
   （如 `1 个 SKU · 3 件`、`缺克重 0 行`），改动文字或拆成多个兄弟元素都会让断言变红。 */

/* 发货主线：把"今天该做什么"从三张并列的卡里提出来，单独成一条流程。
   状态靠**左边框颜色**区分（绿=做过 / 蓝=该做这个 / 黄=有数据缺口），不靠背景色差 —— 深色主题下那点色差读不出来。 */
.td-flow {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex-shrink: 0;
  padding: 14px 16px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
}

.td-flow__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 10px;
}

.td-flow__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
}

.td-flow__hint {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.td-flow__steps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.td-flow__step {
  flex: 1 1 150px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px 9px 13px;
  border: 1px solid var(--wb-border);
  border-left: 3px solid var(--wb-border-strong);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
  cursor: pointer;
}

.td-flow__step:hover {
  border-color: var(--wb-primary);
}

.td-flow__step.is-done {
  border-left-color: var(--wb-success);
}

.td-flow__step.is-now {
  border-left-color: var(--wb-primary);
  background: var(--wb-surface);
}

.td-flow__step.is-gap {
  border-left-color: var(--wb-warning);
}

/* 尚未内建完的步骤（拿货/对账）：虚线右边 —— 一眼看出"还没做完"，而不是"点了没反应" */
.td-flow__step.is-pending {
  border-style: dashed;
  border-left-style: solid;
}

.td-flow__no {
  font-size: 11.5px;
  color: var(--wb-text-muted);
}

.td-flow__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
}

.td-flow__note {
  font-size: 12px;
  color: var(--wb-text-muted);
}

.td-flow__where {
  font-size: 11.5px;
  color: var(--wb-text-muted);
}

/* 「下一步」条：主线里唯一的主按钮所在（其余节点只做跳转） */
.td-flow__next {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--wb-border);
}

.td-flow__nexttext {
  font-size: 12.5px;
  color: var(--wb-text);
}

.td-flow__nexttext b {
  font-weight: 600;
}

.td-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
  align-items: start;
}

/* 卡片：白底 + 投影 + 圆角。原先只有 1px 边框，而画布与白底只差 2% 亮度 → 卡片边界看不出来 */
.td-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  background: var(--wb-surface);
  box-shadow: var(--wb-elev-1);
}

.td-card__head {
  display: flex;
  align-items: center;
  gap: 9px;
}

/* 图标底：给三张卡一个可区分的"身份标记"，比纯文字标题更容易扫 */
.td-card__ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
}

.td-card__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
}

/* 主数值：22px 等宽数字。与正文拉开三档（12 说明 / 13 标题 / 22 数值），
   一眼就知道每张卡的答案是什么。 */
.td-value {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.02em;
  color: var(--wb-text);
  font-variant-numeric: tabular-nums;
}
.td-unit {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0;
  color: var(--wb-text-muted);
}
.td-value--empty {
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 0;
  color: var(--wb-text-muted);
}

/* 事实行：中圆点分隔的横向行（分隔符用伪元素，不进 textContent —— 冒烟断言按 textContent 匹配） */
.td-facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  font-size: 12px;
  color: var(--wb-text-muted);
}
.td-facts > span + span::before {
  content: '·';
  margin-right: 10px;
  color: var(--wb-border-strong);
}
/* 多行说明（空态引导语）改纵向排：横向加点号会在长句中间断开，读不成句 */
.td-facts--stack {
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  line-height: 1.55;
}
.td-facts--stack > span + span::before {
  content: none;
}
.td-warn {
  color: var(--wb-warning);
  font-weight: 500;
}
/* 警示项在横向行里把点号也染成警示色，避免"· 缺克重 0 行"各半截颜色 */
.td-facts > span.td-warn + span::before {
  color: var(--wb-warning);
  opacity: 0.5;
}

.td-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.td-cta {
  align-self: flex-start;
  flex-shrink: 0;
}

.td-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-text-muted);
}

/* 刚导完订单 → 把「待拣」卡的点亮（只引导视线，不加第二个入口：动作仍是卡里那个按钮） */
.td-card.is-fresh {
  border-color: var(--wb-primary);
}

.td-fresh {
  margin: 0;
  font-size: 12px;
  color: var(--wb-success);
}
</style>
