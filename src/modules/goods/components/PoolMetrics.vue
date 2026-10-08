<template>
  <!-- 映射/认款的口径条（两个渲染形态共用：工作台右栏 `PoolPane` 与整宽回落形态 `SkuMappingView`）。
       ⚠️ 为什么抽成一个组件：这一条只有**一条判断规则** —— "0 不列、全零说一句人话" ——
       而它要在两个模板里各出现一次。复制两份的话，改一处漏一处就是两条口径
       （本仓吃过这个亏：同一个意思两套文案，UX-G1 同源）。 -->
  <div class="wb-metabar" data-act="map-stats">
    <!-- ① 各项为 0 **不渲染**（2026-10-08 走查 P0-3 原话："五项都写着 0 和 '—'，
           这页是不是坏了？"）。`is-warn` 于是可以直接写死 —— 能渲染出来的就是 > 0。 -->
    <span v-if="unmapped > 0" class="wb-metric is-warn" data-act="metric-unmapped">
      待关联 <b>{{ unmapped }}</b>
    </span>
    <span v-if="shopUnresolved > 0" class="wb-metric is-warn" data-act="metric-shop">
      店铺未归一 <b>{{ shopUnresolved }}</b>
    </span>
    <span v-if="mapped > 0" class="wb-metric" data-act="metric-mapped">
      已关联 <b>{{ mapped }}</b>
    </span>
    <!-- ② 关联率的 `—`（`groups === 0`，分母不存在）**也不渲染**：
           它不是"0%"，而是"无从计算"（主进程的口径里 `groups = mapped + unmapped + shopUnresolved`），
           摆在条上只会被读成一个数字。`groups > 0` 时即使比率是 0% 也照常渲染 —— 那是**真的 0%**。 -->
    <span v-if="groups > 0" class="wb-metric" data-act="metric-rate">
      关联率 <b>{{ rateText }}</b>
    </span>
    <span v-if="records > 0" class="wb-metric" data-act="metric-records">
      映射记录 <b>{{ records }}</b>
    </span>
    <!-- ③ 全零时不留一条空白横条（那同样像坏了），改说一句**真的**话。
           ⚠️ 这句话必须收紧到"整行真的都无"才说（审查报告 P0-3 的口径）：
           `truncated`（队列可能不完整）与"取不到商品ID"这两种情况恰恰意味着**还有东西没进来**，
           此时说"没有待认的"就是假话。 -->
    <span v-if="allClear" class="wb-metric gd-metabar__clear" data-act="map-allclear">
      队列里还没有待认的店铺商品
    </span>
  </div>
</template>

<script setup lang="ts">
// 指标条：**0 不占位**（`PoolPane.vue` L59 起、`SkuMappingView.vue` L47 起原先各写了一份）。
//
// ⚠️ 「队列里还没有待认的店铺商品」这句**不能说成**「这批商品都认好了」（审查报告 P0-3 的原句）：
//    `全零` ⇒ `groups === 0` 且 `mapped === 0` ⇒ **一个订单组都没有**（`mapped > 0` 时
//    「已关联 N」会渲染、`allClear` 必然为假）。所以这里根本没有"认好了"这个前提 ——
//    说"都认好了"会让用户以为自己认过一遍（`2026-10-08-goods-page-entry-guide.md` 第 4 条
//    "`0` 与 `null` 必须分开"讲的正是同一件事：不能替用户宣布一个它不知道的结论）。
//
// `null` ≠ 空：`stats` 为 `null` 表示**队列还没拉过**，此时**一项都不渲染**（包括那句"没有待认的"），
// 而不是渲染一排 0 —— 首屏那一瞬间说"没有待认的"，与 2026-10-08 那条裁定直接冲突。
import { computed } from 'vue';
import type { SkuMapSummary, SkuQueueStats } from '@/types';

const props = defineProps<{
  /** 队列统计（`null` = 还没拉过） */
  stats: SkuQueueStats | null;
  /** 映射汇总（`null` = 映射页签还没拉过；只用来显示「映射记录」） */
  summary: SkuMapSummary | null;
  /** 关联率的**已格式化**文本（`''` / `'—'` 之外的形状由 `useSkuPool.rateText` 唯一决定） */
  rateText: string;
}>();

const unmapped = computed(() => props.stats?.unmapped ?? 0);
const shopUnresolved = computed(() => props.stats?.shopUnresolved ?? 0);
const mapped = computed(() => props.stats?.mapped ?? 0);
const groups = computed(() => props.stats?.groups ?? 0);
const records = computed(() => props.summary?.total ?? 0);

const allClear = computed(
  () =>
    props.stats !== null &&
    unmapped.value === 0 &&
    shopUnresolved.value === 0 &&
    mapped.value === 0 &&
    groups.value === 0 &&
    !props.stats.truncated &&
    (props.stats.withoutItemId ?? 0) === 0
);
</script>

<style scoped>
/* 全零时这句是**结论**而不是指标：不加 `is-warn`（不是告警），但要让它是可读的一句话。 */
.gd-metabar__clear {
  font-size: 12px;
}
</style>
