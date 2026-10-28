<script setup lang="ts">
// src/modules/shop-accounts/components/HealthPane.vue
// 「基础数据 › 待补清单」—— 把三处散落的"还欠什么"收成一张可点的单子。
//
// ── 它回答的是哪一个问题 ────────────────────────────────────────────────
// 不是"这个资料库有几条"，而是**"我现在最该补哪一样"**。所以每一类都写清三件事：
//   ① 不补会怎样（`why`，一句话，不写"影响数据质量"这种空话）；
//   ② 差在哪几行（明细表：对象 / 差在哪 / 数量）；
//   ③ 去哪补（一个按钮，落到**真的能改它的那一屏**）。
//
// ── 为什么不把数字并成"还欠 181 项" ────────────────────────────────────
// 六类的单位不同：单 / 个 SKU / 款。相加没有意义（同 `MasterDataView` 组徽标那条
// "别把组内各项的数加起来"）。所以页头只说"还欠几类"，每一类自己带单位。
//
// ── 口径边界（与 `src/lib/dataHealth.ts` 头注释同一份，界面必须写出来）──────
//   · 订单看**最近 2000 单**（宿主 `order-shipping-rows` 的硬上限），超了会在页头如实提示；
//   · 发货台总览卡的缺口只算**今天导入的那批**，两个数字不一样是口径不同，不是谁错了。
//     这句话必须出现在界面上 —— 否则用户拿着一页的 47 和另一页的 12 来问"哪个对"。
//
// ── 为什么自己不判缺口 ──────────────────────────────────────────────────
// 判定全在 `src/lib/dataHealth.ts`（纯函数、有单测）。本组件只做三件事：
// 取数（全部走既有取数口）、渲染、跳转。判定写进组件就无法单测，也没法保证
// "标题的数 = 明细累加"（那条规矩在纯层用一次循环钉死）。

import { computed, onMounted, ref } from 'vue';
import {
  orderReplayMappings,
  orderShippingRows,
  productList,
  productVariantList,
} from '@/core/services/ipc';
import { switchModule } from '@/core/services/shell';
import { buildDataHealth, pendingKinds, type HealthCheck } from '@/lib/dataHealth';

/** 订单投影的取数上限（宿主 handler 把 limit 硬夹在 2000）—— 超了要如实说 */
const ORDER_LIMIT = 2000;
/** 产品分页（与「基础数据」徽标同一做法：读全量再算，别只读第一页） */
const PAGE = 500;
/** 变体按批取（preload 把 productIds 夹在 5000，这里按 400 一批更稳） */
const VARIANT_CHUNK = 400;
/** 每一类的明细最多画这么多行（款级进价能到上千行，全画进 DOM 会卡） */
const MAX_ROWS = 50;

const loading = ref(false);
const error = ref('');
const checks = ref<HealthCheck[]>([]);
/** 订单是否被截断（只看了最近 2000 单） */
const ordersTruncated = ref(false);
/** 本次加载时**按已有映射自动补上**的行数（0 = 没有漏网的） */
const autoFixed = ref(0);
/** 自动补映射失败时的一句话（不影响下面的体检，但要让人知道少做了一件事） */
const replayNote = ref('');

const kinds = computed(() => pendingKinds(checks.value));
const done = computed(() => checks.value.filter((c) => c.n === 0));
const todo = computed(() => checks.value.filter((c) => c.n > 0));

/** 某类的明细最多画 `MAX_ROWS` 条，剩下的只报数（别让一页 1000 行把界面拖死） */
function shownItems(c: HealthCheck) {
  return c.items.slice(0, MAX_ROWS);
}
function hiddenCount(c: HealthCheck): number {
  return Math.max(0, c.items.length - MAX_ROWS);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  autoFixed.value = 0;
  replayNote.value = '';
  try {
    // ⭐ 先自愈、再取数 —— 顺序不能反（先算再补，报出的数字立刻过期）。
    //
    // 为什么不给一个「重放映射」按钮：这件事没有信息增益 —— 映射是**已经被确认过的事实**，
    // 把它重新套到存量订单上是确定性推导，唯一不确定的只是"有没有漏"，而那正是这里要算出来的。
    // 让用户点一下，只是把"系统该自愈"变成"人记得点"（项目原则：人工介入最少，见 MEMORY）。
    //
    // 幂等：只碰「没归款 / 占位色」的行，挂在真实颜色上的一律不动；第二次进来通常是 0 行。
    // 失败**不阻断体检** —— 少补几行不影响"还欠什么"的结论，但必须说出来，不能静默。
    const replay = await orderReplayMappings();
    if (replay.success) autoFixed.value = Number(replay.data?.fixedRows ?? 0) || 0;
    else replayNote.value = `按现有映射自动补归属没跑成：${replay.error || '未知原因'}`;

    const [plRes, ordRes] = await Promise.all([
      // 产品：读全量（分页），否则"缺进价"会只数第一页
      (async () => {
        const rows: { id: number; code: string; name: string; status?: string; costCents: number }[] = [];
        for (let page = 0; page < 40; page++) {
          const res = await productList({ offset: page * PAGE, limit: PAGE });
          const list = res.success ? (res.data?.rows ?? []) : [];
          for (const r of list) rows.push({ id: Number(r.id) || 0, code: String(r.code ?? ''), name: String(r.name ?? ''), status: String(r.status ?? ''), costCents: Number(r.costCents) || 0 });
          if (!list.length || rows.length >= Number(res.data?.total ?? 0)) break;
        }
        return rows;
      })(),
      orderShippingRows({ limit: ORDER_LIMIT }),
    ]);

    const variants = await (async () => {
      const ids = plRes.map((p) => p.id).filter(Boolean);
      const out: { productId: number; size: string; color: string; weightG: number; status: string }[] = [];
      for (let i = 0; i < ids.length; i += VARIANT_CHUNK) {
        const res = await productVariantList(ids.slice(i, i + VARIANT_CHUNK));
        for (const v of res.success ? (res.data?.rows ?? []) : []) {
          out.push({
            productId: Number(v.productId) || 0,
            size: String(v.size ?? ''),
            color: String(v.color ?? ''),
            weightG: Number(v.weightG) || 0,
            status: String(v.status ?? 'active'),
          });
        }
      }
      return out;
    })();

    const orders = ordRes.success ? (ordRes.data ?? []) : [];
    ordersTruncated.value = orders.length >= ORDER_LIMIT;
    // 订单是"最近 N 单"（宿主按 id 倒序 LIMIT）—— 截断时清单里"没认款"的数只会偏少，
    // 不会偏多；页头把这句话说出来，用户才知道要不要去清一遍更早的单。
    const pricedCodes = plRes.filter((p) => p.costCents > 0).map((p) => p.code);

    checks.value = buildDataHealth({
      orders: orders.map((o) => ({
        shop: o.shop,
        styleCode: o.styleCode,
        styleColor: o.styleColor,
        color: o.color,
        size: o.size,
        itemId: o.itemId,
      })),
      products: plRes,
      variants,
      pricedCodes,
    });
  } catch (e: unknown) {
    error.value = `读取失败：${e instanceof Error ? e.message : '未知错误'}`;
  } finally {
    loading.value = false;
  }
}

/**
 * 「去补」落到**真能改它的那一屏**。
 *
 * ⚠️ 别在这里自作聪明地"顺便把筛选条件也带上"：`switchModule` 的 action 只到"哪一屏"，
 *    再往下（比如产品列表的「缺克重」筛选）需要目标页配合，当前没有这条协议。
 *    清单已经把**款编码/商品ID**写在明细里，用户到那一页搜一下就到位 —— 指到半路
 *    也比指错地方强，硬塞一个"看起来筛了其实没筛"的跳转更糟。
 */
function goFix(c: HealthCheck): void {
  if (c.target === 'classify') switchModule('today', 'classify');
  else if (c.target === 'goods') switchModule('shop-accounts', 'goods');
}

onMounted(() => void load());
</script>

<template>
  <div class="dh" data-act="health-pane">
    <!-- 页头自己写 flex，不用 `gd-toolbar`：那套类是「货与成本」页的 **scoped** 样式，
         搬到这里一个都没生效（实测：按钮被挤到下一行、贴在左边）—— 借类名不借样式 = 看起来像布局坏了。 -->
    <div class="dh-bar">
      <div class="dh-bar__main">
        <span class="dh-sum" data-act="health-summary">
          <template v-if="loading">正在核对…</template>
          <template v-else-if="!kinds">数据齐了</template>
          <template v-else>还欠 <b>{{ kinds }}</b> 类数据</template>
        </span>
        <span v-if="autoFixed > 0" class="dh-fixed" data-act="health-auto-fixed">
          已按现有映射自动补了 <b>{{ autoFixed }}</b> 行归属
        </span>
        <span v-else-if="replayNote" class="dh-fail" data-act="health-replay-fail">{{ replayNote }}</span>
        <span class="wb-muted dh-scope">
          订单看最近 {{ ORDER_LIMIT }} 单<template v-if="ordersTruncated">（已到上限，更早的单没算进来）</template>；
          发货台总览的缺口只算今天导入的那批，两处数字不同是口径不同
        </span>
      </div>
      <button class="wb-btn" type="button" data-act="health-refresh" :disabled="loading" @click="load">
        {{ loading ? '读取中…' : '重新核对' }}
      </button>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error">{{ error }}</p>

    <!-- 还欠的：一类一块，先写"不补会怎样"，再列明细，最后给一个去处 -->
    <section
      v-for="c in todo"
      :key="c.id"
      class="wb-panel dh-card"
      :data-act="`health-check-${c.id}`"
    >
      <div class="wb-panel__head dh-head">
        <span class="dh-title">{{ c.title }}</span>
        <span class="dh-n" :data-act="`health-n-${c.id}`">{{ c.n }} {{ c.unit }}</span>
        <span class="wb-muted dh-why">{{ c.why }}</span>
        <span class="wb-muted dh-where">{{ c.where }}</span>
        <button
          class="wb-btn wb-btn--primary dh-go"
          type="button"
          :data-act="`health-go-${c.id}`"
          @click="goFix(c)"
        >
          {{ c.action }}
        </button>
      </div>

      <div class="wb-panel__body">
        <!-- 列宽用 `table-layout: fixed` + `colgroup` 给死：
             行内容普遍只有三五个字（`店A` / `商品ID 9001` / `1`），auto 布局会把三列平均摊开，
             "对象"和"差在哪"之间空出半屏 —— 读起来要来回找。固定宽度后中间那列吃掉剩余空间。
             ⚠️ 列宽写在 `col` 上而不是 `td.xxx`：fixed 布局的列宽由表头/colgroup 决定，
                只写 `td` 的宽度声明会静默不生效（吃过的坑）。 -->
        <table class="wb-table dh-table" :data-act="`health-table-${c.id}`">
          <colgroup>
            <col class="dh-col-obj" />
            <col />
            <col class="dh-col-n" />
          </colgroup>
          <thead>
            <tr>
              <th>对象</th>
              <th>差在哪</th>
              <th class="wb-num">数量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in shownItems(c)" :key="it.key" :data-health-key="it.key">
              <td class="wb-mono dh-cell-title" :title="it.title">{{ it.title }}</td>
              <td class="wb-muted dh-cell-detail">{{ it.detail }}</td>
              <td class="wb-num">{{ it.n }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="hiddenCount(c)" class="wb-muted dh-more" :data-act="`health-more-${c.id}`">
          另有 {{ hiddenCount(c) }} 条没列出来 —— 补完上面这些再点「重新核对」
        </p>
      </div>
    </section>

    <!-- 已经齐了的：一行说完，不占六块面板的地 -->
    <section v-if="!loading && done.length" class="wb-panel dh-done">
      <div class="wb-panel__head">
        <span>已经齐了</span>
        <span class="wb-muted" data-act="health-done">{{ done.map((c) => c.title).join(' · ') }}</span>
      </div>
    </section>

    <!-- 全齐时的空态：说清"齐了"是什么意思（别让人以为这一页坏了） -->
    <section v-if="!loading && !kinds && !error" class="wb-panel">
      <div class="wb-panel__body">
        <div class="wb-empty" data-act="health-empty">
          <div class="wb-empty__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
          <p class="wb-empty__title">六类检查都齐了</p>
          <p class="wb-muted">订单认款、颜色、款、尺码、克重、进价都没有缺的</p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dh {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 页头：左边两行字（结论 + 口径），右边一个刷新按钮。
   左侧 `min-width:0` 是必须的 —— 不给它，长句会把按钮顶到下一行。 */
.dh-bar {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.dh-bar__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}
.dh-sum {
  font-size: 14px;
  color: var(--wb-text);
}
.dh-sum b {
  font-size: 16px;
  color: var(--wb-warning, #b45309);
}
/* 自愈回执：只在这一轮真的补过东西时出现，所以可以比口径说明显眼一点
   （它是"刚刚发生了改变"，而口径说明是常驻背景）。 */
.dh-fixed {
  font-size: 13px;
  color: var(--wb-success, #15803d);
}
.dh-fixed b {
  font-size: 14px;
}
.dh-fail {
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-warning, #b45309);
}
/* 口径说明按"次要信息"处理：它必须能被读到，但不该比数字显眼 */
.dh-scope {
  font-size: 12px;
  line-height: 1.5;
}

/* 明细表：列宽给死（见模板注释）。中间列 `width:auto` = 吃掉剩余空间。 */
.dh-table {
  table-layout: fixed;
}
.dh-col-obj {
  width: 220px;
}
.dh-col-n {
  width: 76px;
}

.dh-card {
  overflow: hidden;
}
.dh-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dh-title {
  font-weight: 600;
}
/* 数量用警示色的"数字"，不整块染红（同 wb-metabar 那条：变色的是数字本身） */
.dh-n {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--wb-warning, #b45309);
}
.dh-why {
  font-size: 12px;
  flex: 1 1 auto;
  min-width: 180px;
}
/* 去哪补：与 why 区分开（why 说的是后果，它说的是去处）——
   小一号、靠右，视觉上贴着按钮，让人一眼看出"这句话和这个按钮是一件事" */
.dh-where {
  font-size: 12px;
  white-space: nowrap;
}
.dh-go {
  margin-left: auto;
}

/* 明细：对象列是款编码/店名这类短标识，超长截断（完整值在 title 里）；
   "差在哪"允许换行 —— 那句话是给人读的，截断比换行更糟。 */
.dh-cell-title {
  overflow: hidden;
  text-overflow: ellipsis;
}
.dh-cell-detail {
  white-space: normal;
  line-height: 1.45;
}
.dh-more {
  padding: 8px 12px;
  font-size: 12px;
}
.dh-done .wb-panel__head {
  font-size: 13px;
}
</style>
