<template>
  <div class="wb-page td-view">
    <!-- 总览 = **一块四格数字**（2026-10-22 用户裁定：原先的流程卡 + 订单/待拣/缺口三张卡"暂时没什么意义"）。
         这一屏只回答一个问题：今天的货发到什么程度了 —— 要发几单 / 共几件 / 拿了多少 / 还差多少。
         ⚠️ 四个数字**都来自容器那一份汇总**（`summary.daily`），本面板一个 ipc 都不调：
            "这页说 21 件、那页说 16 行"这类缝，根因就是各页各取一份数。
         ⚠️ 算法在 `@/lib/dailyShip`（纯函数）—— 面板只摆放，不做四则运算。
         ⚠️ 断言钉在 `data-act` 上（`daily-summary` / `stat-orders` / `stat-pieces` / `stat-taken`
            / `stat-remaining` / `daily-scope`），**不按整段文本匹配**：文案会改，锚点不该跟着改。 -->
    <section class="td-daily" data-act="daily-summary">
      <header class="td-daily__head">
        <h2 class="td-daily__title">今天要发</h2>
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
      </template>

      <!-- 空态：这句话本身已经交代了范围（"今天"），所以不再挂口径小字。
           ⚠️ 措辞是「今天还没有导入订单」而不是「还没有订单数据」：库里可能明明有前几天的单，
              说"没有数据"是假话（用户会以为数据丢了）。 -->
      <template v-else>
        <p class="td-daily__empty" data-act="daily-empty">今天还没有导入订单</p>
        <p class="td-daily__note">
          来源①：浏览器采集（自带推送）· 来源②：Excel 导入（订单报表 / 结算明细 / 报价单自动识别）
        </p>
        <!-- 主操作走容器的 `importExcel()`：切到导入页签**并一步直达选文件**
             （只切页签还要用户再找一个按钮 = 白改）。 -->
        <button
          class="wb-btn wb-btn--primary td-daily__cta"
          data-act="empty-import"
          :disabled="importing"
          @click="onEmptyImport"
        >
          {{ importing ? '导入中…' : '导入 Excel' }}
        </button>
      </template>
    </section>
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
import { useShipping } from '../flowCtx';

const { summary, go, importing, importExcel } = useShipping();

const daily = computed(() => summary.value.daily);

/** 已拿占比（0~100）。件数为 0 时进度条不渲染，这里只在有件数时被用到 */
const percent = computed(() => {
  const { pieces, taken } = daily.value;
  if (!(pieces > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((taken / pieces) * 100)));
});

/** 空态的「导入 Excel」：切到导入页签**并立刻弹选文件**（一步直达，不让用户再找一次按钮） */
function onEmptyImport(): void {
  go('import');
  void importExcel();
}
</script>

<style scoped>
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

/* 按钮跟着内容宽度，不铺满整行（铺满会变成"整页只有一个按钮"的压迫感） */
.td-daily__cta {
  align-self: flex-start;
}
</style>
