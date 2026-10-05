<template>
  <div class="wb-page td-import">
    <section class="wb-panel">
      <div class="wb-panel__head">
        <span>导入订单</span>
        <span class="wb-muted">第 1 步 —— 把今天要发的货导进来</span>
      </div>
      <div class="wb-panel__body td-import__body">
        <p class="td-import__lead">
          选一份平台导出的 Excel，会自动识别它是什么（订单报表 / 商品信息 / 报价单 /
          结算明细），落到对应的表里。识别结论与判据会留在下方，可核对。
        </p>
        <div class="td-import__actions">
          <button
            class="wb-btn wb-btn--primary"
            data-act="import"
            :disabled="importing"
            @click="importExcel"
          >
            {{ importing ? '导入中…' : '选择 Excel 文件导入' }}
          </button>
          <span class="wb-muted td-import__hint">
            当前库里有 <b>{{ orders.total }}</b> 行订单（导入 {{ orders.import }} · 采集
            {{ orders.collect }}）
          </span>
        </div>
      </div>
    </section>

    <!-- 上次导入的回执：**这次导入的东西去哪了、接下来该点哪**。
         原先只有一行灰字（"识别为 X → 已导入 N 行"），用户读完既不知道数据进了哪儿、
         也不知道下一步做什么（2026-10-05 用户实报）。现在拆成四段：状态 + 落点 + 下一步 + 判据明细。
         ⚠️ `data-act="import-result"` 与里面那段 `receipt.message` 全文都**不是装饰**：
            冒烟按容器 textContent 判断"这次导入完了没"，判据（`why`）也靠它。 -->
    <div
      v-if="receipt"
      class="td-receipt"
      :class="{ 'td-receipt--nowrite': !receipt.wrote }"
      data-act="import-result"
    >
      <div class="td-receipt__head">
        <span class="td-receipt__badge">{{ receipt.wrote ? '已导入' : '未写入' }}</span>
        <span class="td-receipt__title" data-act="import-title">{{ receipt.title }}</span>
        <button
          class="wb-btn wb-btn--sm wb-btn--ghost td-receipt__close"
          data-act="import-dismiss"
          title="关掉这条回执"
          @click="dismiss"
        >
          ×
        </button>
      </div>
      <!-- ⚠️ 顺序是刻意的：**结论在前、证据垫底**。
           判据那段（`message`）信息量最大但也最长，放在标题和落点之间会把
           "数据去哪了 / 下一步点哪"推到下面去 —— 而这两句才是用户真正要的。 -->
      <p v-if="receipt.landed" class="td-receipt__landed" data-act="import-landed">
        存在 <b>{{ receipt.landed.label }}</b> —— 在{{ receipt.landed.views.join('、') }}看得到
      </p>
      <div v-if="receipt.next.length" class="td-receipt__next" data-act="import-next">
        <span class="td-receipt__nextlabel">下一步</span>
        <button
          v-for="a in receipt.next"
          :key="a.label"
          class="wb-btn"
          :class="{ 'wb-btn--primary': a.primary }"
          :data-act="`import-next-${a.moduleId}`"
          @click="nextGo(a.moduleId)"
        >
          {{ a.label }}
        </button>
      </div>
      <p class="td-receipt__detail" data-act="import-detail">{{ receipt.message }}</p>
    </div>

    <section v-else class="wb-empty" data-act="import-none">
      <p class="wb-empty__title">这一步还没有动作</p>
      <p class="wb-empty__desc">
        导完之后这里会留下一张回执：识别成什么、数据进了哪张表、下一步点哪里。
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
// 「导入订单」页签 = 发货流程第 1 步。
//
// ⚠️ **导入动作不在本组件里**：它在容器（`TodayView.vue`）—— 因为总览页签的空态按钮
//    要能"切过来并立刻弹选文件"。本组件只负责**呈现**（按钮 + 回执 + 当前库里的行数）。
import { computed } from 'vue';
import { useShipping } from '../flowCtx';

const { summary, go, openModule, receipt, importing, importExcel } = useShipping();

const orders = computed(() => summary.value.orders);

/**
 * 回执里的"下一步"原来直接 `switchModule(moduleId)` 跳走；
 * 改造后**能落在本页页签里的一律切页签**（拣货 / 算钱），只有「货与成本」这类
 * 主数据维护页才真跳转（本页没有它的页签）。
 *
 * ⚠️ 表里只列「回执真的会发出来的模块 id」（见 `@/core/services/importSheet` 的 `next[]`）。
 * 原有一条 `'order-insight': 'classify'` 已于 2026-10-05 删除：那个岛整体下架，
 * 回执从来也没发过这个 id —— 归类的落点由流程卡走本页页签（`go('classify')`），
 * 不经这张表。留着它会让人以为还有个同名模块。
 */
const TAB_OF: Record<string, string> = {
  today: 'overview',
  picking: 'picking',
  'order-cost': 'cost',
};

function nextGo(moduleId: string): void {
  const t = TAB_OF[moduleId];
  if (t) go(t);
  else openModule(moduleId);
}

/** 关掉回执（写在容器那份 ref 上：总览的「待拣」卡靠它决定要不要点亮） */
function dismiss(): void {
  receipt.value = null;
}
</script>

<style scoped>
.td-import__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.td-import__lead {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}

.td-import__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.td-import__hint {
  font-size: 12px;
}

/* 导入回执：一张常驻卡，回答"这是什么文件 / 数据去哪了 / 下一步点哪"。
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
}
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
  padding: 1px 6px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 11.5px;
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

/* 落点：**回答"数据去哪了"**的那一行 —— 正文色、"存到 X"加粗，比明细重一档 */
.td-receipt__landed {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--wb-text);
}
.td-receipt__landed b {
  font-weight: 600;
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
</style>
