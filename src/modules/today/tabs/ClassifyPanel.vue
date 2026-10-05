<template>
  <div class="wb-page cl-view" data-act="classify-panel">
    <!-- 指标条：全是**计数**（有多少活要干）。
         ⚠️ 每格必须是「标签 + 空格 + <b>数字</b>」同一串文本（冒烟按 textContent 取子串）。 -->
    <div class="wb-metabar cl-stats" data-act="cl-stats">
      <span class="wb-metric">待核对 <b>{{ total }}</b></span>
      <span class="wb-metric" :class="{ 'is-warn': counts.unclassified > 0 }" data-act="cl-metric-unclassified">
        未归类 <b>{{ counts.unclassified }}</b>
      </span>
      <span class="wb-metric">识别库 <b>{{ counts.styles }}</b> 款</span>
      <!-- 「本页 N 个商品」= 这一页真正要**做决定**的量（同一商品的多行只需定一次）。
           没有商品ID 的报表（免图/无该列）里这个数恒为 0 ⇒ 那时**不显示**这一格：
           "0 个商品"会让人以为坏了，而实际是"这份数据没有这个维度"。 -->
      <span v-if="distinctProducts" class="wb-metric" data-act="cl-metric-products">
        本页 <b>{{ distinctProducts }}</b> 个商品
      </span>
    </div>

    <!-- 工具条：查询 + 刷新。本页**只剩逐行动作** —— 原「识别未归类」批量按钮已于 2026-10-05
         按用户要求删除（为什么删见 script 头注释），不要再加回来而不改冒烟。 -->
    <div class="cl-bar">
      <input
        v-model="search"
        class="wb-input wb-input--sm cl-search"
        data-act="cl-search"
        placeholder="搜索订单号 / 店铺 / 款式 / 颜色…"
        @keyup.enter="doSearch"
      />
      <button type="button" class="wb-btn wb-btn--sm" data-act="cl-query" @click="doSearch">查询</button>
      <button type="button" class="wb-btn wb-btn--sm" data-act="cl-reload" :disabled="loading" @click="reload">
        刷新
      </button>
    </div>

    <p v-if="error" class="wb-notice wb-notice--error" data-act="cl-error">{{ error }}</p>

    <section class="wb-panel">
      <div class="wb-panel__head">
        <span>待核对订单</span>
        <span class="wb-muted">
          改完点「保存」重归类；识别结果没问题的点「确认无误」，之后不再出现在这里。在下拉里点名某个款＝认定这个商品，以后它的订单会自动归类。行内按回车＝保存这一行并跳到下一条
        </span>
        <span class="cl-actions">
          <button
            type="button"
            class="wb-btn wb-btn--sm"
            data-act="cl-all-ok"
            :disabled="busy || !total"
            @click="confirmAll"
          >
            全部确认无误
          </button>
        </span>
      </div>

      <div v-if="rows.length" class="wb-panel__body wb-table-wrap">
        <table class="wb-table cl-table" data-act="cl-table">
          <thead>
            <tr>
              <th class="cl-thumb-col">图</th>
              <th>订单号</th>
              <th>店铺</th>
              <th>品类</th>
              <th>颜色</th>
              <th>Logo</th>
              <th>尺码</th>
              <th class="cl-style-col">归属款</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in rows" :key="o.id" @keydown.enter="onRowEnter(o, $event)">
              <td>
                <!-- 核对必须看得见图：识别结果对不对，是**拿图比**出来的而不是读文字读出来的 -->
                <img
                  v-if="thumbs[o.localPath || '']"
                  class="wb-thumb"
                  :src="thumbs[o.localPath || '']"
                  :alt="o.orderNo"
                />
                <span v-else class="wb-thumb wb-thumb--empty" title="这条订单没有主图"></span>
              </td>
              <td class="wb-mono">
                {{ o.orderNo }}
                <!-- ⭐「同商品」徽标：这几行是**同一家店的同一个商品ID** ⇒ 只需定一次款。
                     它只在 >1 时出现；没有商品ID 的行（`o.itemId` 空串）永远没有它 ——
                     "同一个商品"与"没有商品ID"是两件事，别让它们长成一个样子。 -->
                <span
                  v-if="sameCount(o) > 1"
                  class="wb-tag cl-same"
                  :data-act="`cl-same-${o.id}`"
                  :title="`本页有 ${sameCount(o)} 行是这家店的同一个商品。给其中任意一行点名款，其余行以后会自动归类`"
                >
                  同商品 ×{{ sameCount(o) }}
                </span>
              </td>
              <td>{{ o.shop || '—' }}</td>
              <td>
                <input
                  v-model="draftOf(o).category"
                  class="wb-input wb-input--sm cl-cell"
                  :data-act="`cl-cat-${o.id}`"
                />
              </td>
              <td>
                <input
                  v-model="draftOf(o).color"
                  class="wb-input wb-input--sm cl-cell"
                  :data-act="`cl-color-${o.id}`"
                />
              </td>
              <td>
                <input
                  v-model="draftOf(o).logo"
                  class="wb-input wb-input--sm cl-cell"
                  :data-act="`cl-logo-${o.id}`"
                />
              </td>
              <td>{{ o.size || '—' }}</td>
              <td>
                <select
                  v-if="styles.length"
                  v-model.number="draftOf(o).styleId"
                  class="wb-input wb-input--sm cl-cell"
                  :data-act="`cl-style-${o.id}`"
                >
                  <option :value="0">自动匹配{{ o.styleCode ? `（当前 ${o.styleCode}）` : '（未归类）' }}</option>
                  <option v-for="s in styles" :key="s.id" :value="s.id">
                    {{ s.code }}{{ s.name ? ` · ${s.name}` : '' }}
                  </option>
                </select>
                <span v-else class="wb-muted">识别库为空</span>
              </td>
              <td class="cl-ops">
                <button
                  type="button"
                  class="wb-link"
                  :data-act="`cl-save-${o.id}`"
                  :disabled="busy || !isDirty(o)"
                  @click="saveOne(o)"
                >
                  保存
                </button>
                <button
                  type="button"
                  class="wb-link"
                  :data-act="`cl-ok-${o.id}`"
                  :disabled="busy"
                  @click="confirmOne(o)"
                >
                  确认无误
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="wb-empty" data-act="cl-empty">
        <p class="wb-empty__title">{{ emptyTitle }}</p>
        <p class="wb-empty__desc">{{ emptyDesc }}</p>
        <div v-if="!hasOrders" class="wb-empty__actions">
          <button type="button" class="wb-btn wb-btn--primary" data-act="cl-goto-import" @click="go('import')">
            去导入订单
          </button>
        </div>
      </div>

      <div v-if="total > PAGE_SIZE" class="wb-panel__foot wb-pager" data-act="cl-pager">
        <span>共 {{ total }} 条 · 第 {{ page + 1 }} / {{ totalPages }} 页</span>
        <span class="wb-pager__spacer"></span>
        <button
          type="button"
          class="wb-btn wb-btn--sm"
          data-act="cl-prev"
          :disabled="page <= 0 || loading"
          @click="gotoPage(page - 1)"
        >
          上一页
        </button>
        <button
          type="button"
          class="wb-btn wb-btn--sm"
          data-act="cl-next"
          :disabled="page >= totalPages - 1 || loading"
          @click="gotoPage(page + 1)"
        >
          下一页
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
// 「归类核对」页签 = 发货流程第 2 步（2026-10-05 从「订单归类」岛内建过来）。
//
// **这一页干什么**：订单导进来只是"有这些单"，还不知道每单是什么款 —— 本页把"还没归到款的行"
// 逐条核对/修正。两个动作，都在行内：
//   · **改品类/颜色/Logo** → 保存时按指纹重归类（`orderUpdate(reclassify)`）；
//   · **在下拉里点名某个款** → 挂到该款并把指纹记入它（**后续同样的指纹会命中同一款**）。
//
// ⚠️ **「识别未归类」批量动作已于 2026-10-05 按用户要求删除**（原按钮 `data-act="cl-recognize"`）。
//   它做的事是"对本页 30 行里有图无款的行，逐张跑视觉模型并直接落库"。删它的三条理由：
//     ① **慢得离谱且绑住界面**：串行识图 20~60s/张 ⇒ 跑满一页十几分钟；
//     ② **范围是"当前页"而不是"所有未归类"**：翻页要重跑，用户以为全跑了其实只跑了一页；
//     ③ **直接落库**（reclassify + 写指纹），错了要逐条回退 —— 识别这种事更适合"先给建议、
//        人看一眼再定"，而不是替用户下结论。
//   ⇒ **识别该以什么形态回来尚未拍板**（导入时后台跑 / 逐行「识这张图」按钮 / 只做建议不落库）。
//   在拍板前本页只留逐行核对这条**必然正确**的路径。
//
//   ⚠️ 连带：识别原语（`readEngine` / `recognizeOrder`）仍保留在 `../classify.ts`，**当前无调用方**
//   —— 留着是因为「设置 › 识别」写的那份引擎配置必须有个读取方，且它们正是重新接入识别时要用的现成件。
//   若最终决定不做自动识别，**两者与「设置 › 识别」页应一并删除**（别让它们烂在那里）。
//
// **照功能不照样式**：移植自原「订单归类」岛的**纠正页**（该岛已于 2026-10-05 整体下架，
// 源码留档不入库，`CHANGELOG.md` 的 Removed 段有清单）—— 原页用自己的 `.panel/.bar/.btn`；
// 内建页一律走 `.wb-*`（见 `src/styles/index.css`）。
//
// **这一页砍掉了什么（"哪些在流程里有用的"的裁量，2026-10-05）**：
//   · **「识别未归类」批量识别按钮** —— 见上方 ⚠️（慢 / 只跑当前页 / 直接落库）。
//   · 岛里的「导入与识别」队列页（`oi_queue` 中间表 + 断点续跑）—— 宿主的导入**直落订单表**，
//     队列是多余的中间层。
//   · 行内改**款式展示名** —— 展示名是主数据，维护在「货与成本 › 产品」；本页只做"核对归类"，
//     一个输入框能改的东西越少，核对这件事越不容易被误操作。
//   · 岛的「识别库 / 透视 / 明细 / 设置」四个页 —— 都不是每日动作（主数据 / 分析 / 配置）。
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { toast } from '@/core/services/toast';
import * as ipc from '@/core/services/ipc';
import type { OrderRecord, SkuBackfillOutcome, StyleRecord } from '@/types';
import { useShipping } from '../flowCtx';
import {
  PAGE_SIZE,
  listPending,
  listStyles,
  markCorrected,
  pendingCounts,
  saveCorrection,
} from '../classify';

const { token, go, bump } = useShipping();

interface Draft {
  category: string;
  color: string;
  logo: string;
  /** 归属款 id；0 = 自动匹配（保持/重建当前归属） */
  styleId: number;
}

const loading = ref(false);
const busy = ref(false);
const error = ref('');
const search = ref('');
/** 已提交给主进程的关键字（与输入框里正在敲的 `search` 分开 —— 否则每次输入都会触发分页重置） */
const applied = ref('');
const page = ref(0);

const rows = ref<OrderRecord[]>([]);
const total = ref(0);
const styles = ref<StyleRecord[]>([]);
const counts = reactive({ pending: 0, unclassified: 0, styles: 0 });
const thumbs = ref<Record<string, string>>({});
const drafts = reactive<Record<number, Draft>>({});

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
/** 库里到底有没有订单（区分"没有待核对"与"压根还没导入"两种空态） */
const hasOrders = computed(() => counts.unclassified > 0 || counts.pending > 0 || total.value > 0);
const emptyTitle = computed(() => {
  if (!hasOrders.value) return '还没有订单';
  if (applied.value) return '没有匹配的订单';
  return '全部订单都核对完了';
});
const emptyDesc = computed(() => {
  if (!hasOrders.value) {
    return '核对的对象是导入进来的订单行。先在第 1 步「导入订单」把平台导出的订单报表导进来。';
  }
  if (applied.value) return '换个关键字试试，或清空搜索框看全部待核对订单。';
  return '这里的每一行都点过「保存」或「确认无误」。新导入的订单会重新出现在这里。';
});

/** 当前订单归属款对应的款 id（无归属为 0） */
function currentStyleId(o: OrderRecord): number {
  return styles.value.find((s) => s.code === o.styleCode)?.id ?? 0;
}

// ───────────────────────────────────────── 「同商品」分组（这一页真正要做多少决定）

/**
 * 分组键 = **店铺原文 + 商品ID**。商品ID 由主进程给（`OrderRecord.itemId`），渲染层不自己推 ——
 * 它与回流写映射时用的是同一个 `extractSkuFields`，推两遍就会出现"徽标说同商品、回流按另一个键记"。
 *
 * ⚠️ 已知的**欠算**：这里用的是店铺**原文**，而回流用的是归一后的店铺实体。同一家店在报表里
 * 写法不同（多一个空格/全角括号）时，这里会当成两个商品（徽标少算）。刻意不修：要修就得把
 * 店铺归一下沉到渲染层（那是 `sk_name_map` 的事，两处各判一次必分叉）。徽标是**提示**不是承诺，
 * 少算只会让人多核对一次，不会把两件商品混成一件。
 */
function productKey(o: OrderRecord): string {
  const itemId = String(o.itemId ?? '').trim();
  if (!itemId) return '';
  return `${String(o.shop ?? '').trim()}\u0000${itemId}`;
}

/** 本页每个商品占了几行（只收有商品ID 的行） */
const productRows = computed(() => {
  const m = new Map<string, number>();
  for (const o of rows.value) {
    const k = productKey(o);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
});

/** 这一行所属商品在本页占了几行；0 = 这行没有商品ID（**不是** 1 —— 两者含义完全不同） */
function sameCount(o: OrderRecord): number {
  const k = productKey(o);
  return k ? (productRows.value.get(k) ?? 1) : 0;
}

/** 本页覆盖多少个商品（0 ⇒ 这份报表没有商品ID 列，指标格整格不显示） */
const distinctProducts = computed(() => productRows.value.size);

// ───────────────────────────────────────── 键盘流（回车＝保存并往下走）

/** 下一次取数完成后要把焦点送到的**行下标**；-1 = 不送 */
let focusRowIdx = -1;

/**
 * 把焦点送到目标行的「归属款」下拉 —— 这是逐行核对的**起点控件**（改品类/颜色是例外路径）。
 *
 * ⚠️ 用**下标**而不是订单 id：保存会把该单置为已核对（`updateOrder` 里 `corrected = 1`），
 * 它随即离开待核对列表、后面的行**整体上移一位** ⇒ "下一条"在取数后正好落在同一下标上。
 * 钉在 id 上会找不到元素（那一行已经不在了），症状是"焦点丢了"，很难查。
 */
async function applyFocus(): Promise<void> {
  if (focusRowIdx < 0) return;
  const i = Math.min(focusRowIdx, Math.max(rows.value.length - 1, 0));
  focusRowIdx = -1;
  const o = rows.value[i];
  if (!o) return;
  await nextTick();
  document.querySelector<HTMLElement>(`[data-act="cl-style-${o.id}"]`)?.focus();
}

/**
 * 行内回车：**有改动就保存**（保存完焦点自动落到下一条），没有改动就单纯往下走一格。
 *
 * 焦点在按钮上时直接放行 —— 按钮的原生"回车＝点击"照常发生（Tab 到「保存」再按回车
 * 是一条很自然的路径，在这里拦掉会让它变成"按了没反应"）。
 */
function onRowEnter(o: OrderRecord, ev: KeyboardEvent): void {
  if (busy.value) return;
  const t = ev.target as HTMLElement | null;
  if (t?.tagName === 'BUTTON') return;
  const idx = rows.value.findIndex((r) => Number(r.id) === Number(o.id));
  if (isDirty(o)) {
    focusRowIdx = idx; // 该行会被置为已核对并离开列表 ⇒ 同一下标就是"下一条"
    void saveOne(o);
    return;
  }
  focusRowIdx = idx + 1; // 没改动 ⇒ 什么都不消失，直接去下一行
  void applyFocus();
}

/** 取（并按需建立）一行的草稿 —— 行是主进程给的只读快照，编辑态单独放，避免和"刷新"打架 */
function draftOf(o: OrderRecord): Draft {
  const id = Number(o.id ?? 0);
  const cur = drafts[id];
  if (cur) return cur;
  const d: Draft = {
    category: o.category ?? '',
    color: o.color ?? '',
    logo: o.logo ?? '',
    styleId: currentStyleId(o),
  };
  drafts[id] = d;
  return d;
}

/** 有改动才允许保存（"点保存但什么也没改"是噪音；也让脏值一眼看得出来） */
function isDirty(o: OrderRecord): boolean {
  const d = draftOf(o);
  return (
    d.category !== (o.category ?? '') ||
    d.color !== (o.color ?? '') ||
    d.logo !== (o.logo ?? '') ||
    d.styleId !== currentStyleId(o)
  );
}

/** 选款后清空品类/颜色输入里的"旧值干扰"不做：字段是字段，归属是归属，各改各的 */

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [pend, st, cnt] = await Promise.all([
      listPending({ offset: page.value * PAGE_SIZE, limit: PAGE_SIZE, search: applied.value }),
      listStyles(),
      pendingCounts(),
    ]);
    rows.value = pend.rows;
    total.value = pend.total;
    if (total.value > 0 && page.value > totalPages.value - 1) {
      // 删除/确认后当前页可能超出范围 —— 回退一页重取，别停在空白页
      page.value = totalPages.value - 1;
      loading.value = false;
      await load();
      return;
    }
    styles.value = st;
    counts.pending = cnt.pending;
    counts.unclassified = cnt.unclassified;
    counts.styles = cnt.styles;
    // 草稿按行重建：主进程回来的才是真值，旧的编辑态一律作废
    for (const k of Object.keys(drafts)) delete drafts[Number(k)];
    for (const o of rows.value) draftOf(o);
    await loadThumbs();
    // 键盘流：保存后（或按回车往下走）把焦点送回目标行 —— 必须在**取数之后**做，
    // 否则元素还是上一批的老 DOM（保存会把那一行移走、后面的行整体上移）
    await applyFocus();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '读取待核对订单失败';
  } finally {
    loading.value = false;
  }
}

/** 缩略图合批一次往返（路径去重；`orderImageThumbBatch` 内部已按上限拆批） */
async function loadThumbs(): Promise<void> {
  const paths = [...new Set(rows.value.map((o) => String(o.localPath ?? '')).filter(Boolean))];
  thumbs.value = {};
  if (!paths.length) return;
  const t = await ipc.orderImageThumbBatch(paths.map((localPath) => ({ localPath, maxEdge: 96 })));
  if (!t.success) return;
  paths.forEach((p, i) => {
    const url = t.data?.dataUrls?.[i];
    if (url) thumbs.value[p] = url;
  });
}

function doSearch(): void {
  applied.value = search.value.trim();
  page.value = 0;
  void load();
}

function gotoPage(p: number): void {
  page.value = p;
  void load();
}

function reload(): void {
  void load();
}

/**
 * ⭐ 回流结果的一句话（点名校时宿主会把「(店铺, 商品ID) → 款 + 色」记进确定性层，
 * 该商品**以后**的订单就自动归类、不再进本页）。
 *
 * 只对**用户需要知道**的三种情况说话：
 *   · `written`  —— 记住了（含"顺带把历史几单也归好了"）。不说这句，用户不会知道这条“省力”存在，
 *                  也就不会去"多判几次"——而这件事的价值恰恰来自重复发生；
 *   · `conflict` —— **没**覆盖既有映射。这是最需要说清的一支：不说的话用户会以为记住了，
 *                  下次看到"同商品还是旧款"会完全查不出原因；
 *   · `shopUnresolved` —— 店铺没归一，暂时记不住，并指出去哪解决（否则又是一次"点了没反应"）。
 * 其余（无商品ID / 产品库还没这个款 / 产品域未建）不打断：那几种情况下**本来就无处可记**，
 * 弹一句技术原因只会让人以为出错了。
 */
function backfillNote(bf?: SkuBackfillOutcome): string {
  switch (bf?.status) {
    case 'written': {
      const more = bf.reassigned > 0 ? `，同一商品另有 ${bf.reassigned} 单一起归好了` : '';
      return `；已记住这个商品 → ${bf.spec ? '款和颜色' : '款'}，以后它自动归类${more}`;
    }
    case 'conflict':
      // ⚠️ 入口名必须写**真实存在**的（「货与成本」是模块名，映射清单是它页内的一段）——
      //    写成「货与成本 › 商品ID 映射」这种自造路径会被 `tests/uxEntryNames.spec.ts` 判悬空入口名：
      //    用户照着提示去找不到东西，而这条错只有人真去点才会发现。
      return `；这个商品已配过映射（${bf.conflictCode || '其他款'}），没敢覆盖 —— 要改绑请到「货与成本」的映射清单里改`;
    case 'shopUnresolved':
      // 店铺登记在「店铺账号管家」岛里（与「货与成本 › 商品ID 映射」页给用户的指路完全一致）
      return '；这家店还没归一，暂时记不住这个商品（请先到「店铺账号管家」的「店铺登记」把这家店认下来）';
    default:
      return '';
  }
}

async function saveOne(o: OrderRecord): Promise<void> {
  const d = draftOf(o);
  if (!isDirty(o)) return;
  busy.value = true;
  try {
    const fieldsChanged = d.category !== (o.category ?? '') || d.color !== (o.color ?? '');
    const r = await saveCorrection({
      id: Number(o.id ?? 0),
      category: d.category,
      color: d.color,
      logo: d.logo,
      features: Array.isArray(o.features) ? o.features : [],
      targetStyleId: d.styleId,
      fieldsChanged,
    });
    const base = r.styleCode ? `已保存，归属 ${r.styleCode}` : '已保存（未归到款）';
    // 回流"没生效"时用 info 色调：归属是成功的，别让红/绿把两件事混成一件
    const tone = r.skuBackfill?.status === 'conflict' || r.skuBackfill?.status === 'shopUnresolved' ? 'info' : 'success';
    toast(base + backfillNote(r.skuBackfill), tone);
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '保存失败', 'error');
  } finally {
    busy.value = false;
  }
}

async function confirmOne(o: OrderRecord): Promise<void> {
  busy.value = true;
  try {
    const n = await markCorrected([Number(o.id ?? 0)]);
    if (n) toast('已确认无误', 'success');
    else toast('订单不存在或已核对', 'info');
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '标记失败', 'error');
  } finally {
    busy.value = false;
  }
}

async function confirmAll(): Promise<void> {
  busy.value = true;
  try {
    const n = await markCorrected({ all: true });
    toast(`已把 ${n} 条订单标记为已核对`, 'success');
    page.value = 0;
    bump();
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '标记失败', 'error');
  } finally {
    busy.value = false;
  }
}

// ~~批量识别（`cl-recognize` / `cl-stop` / 进度条 `cl-progress`）~~
// **已删（2026-10-05，用户要求）** —— 原因见 script 头注释的三条（慢 / 只跑当前页 / 直接落库）。
// 原实现留档在 git 历史（该提交同时删掉 `readEngine` / `recognizeOrder` 在本页的调用）。
// ⚠️ 重新加回来时必须同步 `scripts/today-ui-smoke.mjs` 的 `classify` 段 —— 那里现在有一条
//    **反向断言**「工具条不再有识别按钮」，加了按钮它会红，那是设计如此（逼你确认是"要加回来"）。

onMounted(() => void load());
// 保活的代价要还回去：容器 `token` 变了（导入 / 别处改了订单）就重取本页
watch(
  () => token.value,
  () => void load()
);
</script>

<style scoped>
/* 面板区自己滚（外层 `.td-panels` 是 overflow:hidden），所以这里不要 flex:1 */
.cl-view {
  gap: 12px;
}
.cl-stats {
  flex-shrink: 0;
}
.cl-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.cl-search {
  width: 300px;
  max-width: 40vw;
}
/* 面板头右侧动作区（`.wb-panel__head` 是 flex，无"推右"工具类） */
.cl-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  font-weight: 400;
}
.cl-table {
  width: 100%;
}
.cl-cell {
  width: 100%;
  min-width: 76px;
}
.cl-thumb-col {
  width: 48px;
}
/* 「同商品」徽标紧跟在单号后面：它是**这一行的属性**，不是独立一列
   （独立成列会让"没有商品ID"的行留一个大空格，看着像缺数据） */
.cl-same {
  margin-left: 6px;
}
.cl-style-col {
  min-width: 180px;
}
/* 操作列：两个文字动作排一行，窄窗口下允许换行 */
.cl-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
</style>
