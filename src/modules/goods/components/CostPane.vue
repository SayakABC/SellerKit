<script setup lang="ts">
// src/modules/goods/components/CostPane.vue
// 「货与成本 › 进价」—— **款级进价维护**（P4）。
//
// 三件事，对应三块界面：
//   ① 录入/改价：选款 + 填价 + 生效日 → `ae-cost-map-upsert-manual`（写 `source='manual'`）
//   ② 还没维护进价的款：`pl_products` 减去「有成本的款」= **可操作的待办**。
//      ⭐ 这是本页相对「导入模板」的独有价值 —— 导入不会告诉你**哪些款漏了**。
//   ③ 款级成本表：一行一款，显示**当前生效**的价与来源；展开看该款的生效区间（可删 manual 行）
//
// ⭐ 2026-10-10 整页改版（用户："不够直观，也不好看"）。改的是**信息架构**，不只是皮肤：
//   · 两栏：**左=行动区**（录入框 + 待补清单）**右=现状表**（款级进价）。改版前三块是**等宽平铺**
//     的纵向堆叠 —— 一屏从上到下全是同一重量的白卡，"先做什么 / 现在什么样"读不出来；
//     宽屏下每块内部还大片留白（录入行只占左边 1/3，右边空着）。
//     ⭐ 判据：**缺 → 有** 是这一页唯一的动线，两栏正好是这条动线的两端（左补、右看）。
//     窄窗口（<1180px）改上下堆叠，判据与坑同 `GoodsWorkbenchView`（见文末 @media 注释）。
//   · 录入框加了**回显**（`cost-echo`）：填了编码就当场说清"这是哪个款、它现在的价是多少、
//     来源是什么"。改版前只能看到一个光秃秃的编码输入框 —— 改价前无法核对改的是谁，
//     而"价写错了款"在这张表上看起来完全正常（多一行没人用的价）。
//   · 待补清单从"整行灰字 + 右侧一个链接"改成**整行可点**的按钮（一次点击带进录入框）。
//   · 展开区标出**哪条正在生效**（改版前要自己按日期推）。
//
// 口径纪律（三条，都不是本页自行发明）：
//   · 「当前生效那条」用 `pickCostInterval`（`@/lib/orderCost`）—— 与算钱 / 拣货页挑的是**同一条**。
//     页面自己按日期挑会让"这里写 12.34（手工）、利润里算 10.00（拿货）"这种漂移无声发生。
//   · 写入口径在宿主（`electron/manual-costs.ts`）：值相同不写、缺省生效日 = 当天。
//     本页**不重复实现**这些判断，只把用户填的东西传过去、把回执读出来。
//   · 进价是**元**（人填的），库里存**分**。
//
// 为什么不做"批量改价"：批量已经在导入模板里（导出 → 改 → 导回）。同一能力两个平级入口，
// 用户会猜哪个才是"真的"。本页只做**单款**，并在缺价清单上给"填进价"直接落到录入框。
//
// ⚠️ 选择器契约（`scripts/goods-ui-smoke.mjs` 的 `cost` 步）—— 改版**一个都没动**：
//   cost-table / cost-save / cost-code / cost-price / cost-row-expand / cost-current /
//   cost-source / cost-iv-delete / cost-missing / cost-truncated / cost-empty /
//   `[data-cost-code]` / `[data-cost-detail]` / `.ct-iv tbody tr`。
//   `[data-act="cost-current"]` 的 `flat()` 必须**恰好**是 `12.34` ⇒ 「元」这个后缀
//   只能放在它**外面**（放进同一个 data-act 里会变成 `12.34元`，断言立刻红）。
import { computed, onMounted, reactive, ref, watch } from 'vue';
import * as ipc from '@/core/services/ipc';
import { unwrapApi } from '../unwrapApi';
import { todayKey } from '../productIo';
import { toast } from '@/core/services/toast';
import { pickCostInterval } from '@/lib/orderCost';
import type { CostInterval } from '@/lib/orderCost';
import type { AeCostMapItem } from '@/types';
import ProductPicker from './ProductPicker.vue';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';

const props = defineProps<{
  /** 页级「刷新」信号：值一变就重取（成本可能刚被拿货对账写新） */
  refreshNonce?: number;
}>();

const loading = ref(false);
const busy = ref(false);
const error = ref('');

const costRows = ref<AeCostMapItem[]>([]);
/** 产品库（款编码 + 款名）；用于缺价清单与款名校验。翻页拉全量 —— 见 `loadProducts` */
const products = ref<{ code: string; name: string }[]>([]);
/** 产品数超过翻页上限时为 true（缺价清单只覆盖前 N 款，界面要说出来） */
const productsTruncated = ref(false);

const search = ref('');
const expanded = ref('');
const pickerOpen = ref(false);
const pendingDelete = ref<AeCostMapItem | null>(null);

const draft = reactive({ code: '', price: '', from: todayKey() });

/** 导出侧 / 界面侧共用的一份形状转换（分 → 元，与 `pickCostInterval` 的入参同构） */
function toInterval(r: AeCostMapItem): CostInterval {
  return {
    styleCode: String(r.styleCode ?? ''),
    effectiveFrom: String(r.effectiveFrom ?? ''),
    unitPrice: (Number(r.unitPriceCents) || 0) / 100,
    source: String(r.source ?? ''),
  };
}

const yuan = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? '—' : (Number(cents) / 100).toFixed(2);

/** 来源说人话（`manual` / `purchase` 是库里的词，不是给用户看的） */
function sourceLabel(s: string): string {
  return s === 'manual' ? '手工录入' : '拿货对账';
}

interface CostStyleRow {
  code: string;
  name: string;
  /** **当前生效**的那条（与算钱 / 拣货同源口径）；null = 理论上不会出现 */
  current: CostInterval | null;
  intervals: AeCostMapItem[];
}

/** 款编码 → 该款的成本区间（库层已按 (款, 生效日) 升序） */
const intervalsByCode = computed(() => {
  const m = new Map<string, AeCostMapItem[]>();
  for (const r of costRows.value) {
    const code = String(r.styleCode ?? '');
    if (!code) continue;
    const list = m.get(code);
    if (list) list.push(r);
    else m.set(code, [r]);
  }
  return m;
});

const styleRows = computed<CostStyleRow[]>(() => {
  const costs = costRows.value.map(toInterval);
  const today = todayKey();
  const nameByCode = new Map(products.value.map((p) => [p.code, p.name]));
  const out: CostStyleRow[] = [];
  for (const [code, intervals] of intervalsByCode.value) {
    out.push({
      code,
      // 款名优先取成本行自带的（导入时写进去的），其次问产品库
      name: intervals.find((x) => x.styleName)?.styleName || nameByCode.get(code) || '',
      current: pickCostInterval(costs, code, today),
      intervals,
    });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
});

const filteredRows = computed(() => {
  const q = search.value.trim().toUpperCase();
  if (!q) return styleRows.value;
  return styleRows.value.filter(
    (r) => r.code.toUpperCase().includes(q) || r.name.toUpperCase().includes(q)
  );
});

/** 还没维护进价的款（可操作待办）。上限与 `loadProducts` 的翻页护栏一致 */
const missing = computed(() => {
  const has = new Set(styleRows.value.map((r) => r.code));
  return products.value.filter((p) => !has.has(p.code));
});

/** 待办清单一次最多渲染多少条（再多也在同一条 `wb-panel__body` 里滚，但 DOM 不该无上限） */
const MISSING_SHOWN = 300;

/* ---- 录入框的**回显**（2026-10-10 改版新增）----
   改版前：填了编码之后界面上没有任何反馈 —— 用户改价前看不到"这是哪个款、它现在的价是多少"。
   而 `ae_cost_map` 里一行写错的价**看起来完全正常**（只是永远不会有订单取到它），
   所以"改之前先能核对"不是装饰，是这一页最关键的一处防错。 */
const draftHit = computed<CostStyleRow | null>(() => {
  const code = draft.code.trim();
  if (!code) return null;
  return styleRows.value.find((r) => r.code === code) ?? null;
});
const draftIsProduct = computed(() => {
  const code = draft.code.trim();
  return code ? products.value.some((p) => p.code === code) : false;
});
/**
 * 输入中的编码是不是某个款的**前缀**。
 * 用途只有一个：打字打到一半（"S" → "S1"）时别急着说「产品库里没有这个款」。
 * 那属于**在用户还没输完就报错**，是噪声而不是帮助。
 */
const draftIsPrefix = computed(() => {
  const q = draft.code.trim().toUpperCase();
  if (!q) return false;
  return products.value.some((p) => p.code.toUpperCase().startsWith(q));
});

const echo = computed(() => {
  const code = draft.code.trim();
  if (!code) return '';
  const hit = draftHit.value;
  if (hit) {
    const name = hit.name ? ` ${hit.name}` : '';
    if (!hit.current) return `${code}${name} · 还没有生效的进价`;
    return (
      `${code}${name} · 当前 ${Number(hit.current.unitPrice).toFixed(2)} 元` +
      `（${sourceLabel(hit.current.source)}，${hit.current.effectiveFrom} 起生效）`
    );
  }
  if (draftIsProduct.value) return `${code} · 还没有进价 —— 保存后它从 ${draft.from} 起生效`;
  if (products.value.length && !draftIsPrefix.value) {
    return `${code} · 产品库里没有这个款编码（保存会被拦下，请用「选款」挑一个）`;
  }
  return '';
});

/** 展开区里"正在生效的那条"—— 与 `current` 同源（按生效日 + 来源比） */
function isCurrentInterval(row: CostStyleRow, iv: AeCostMapItem): boolean {
  return (
    !!row.current &&
    row.current.effectiveFrom === String(iv.effectiveFrom) &&
    row.current.source === String(iv.source)
  );
}

/** 一次拉回的产品数上限（40 页 × 500，与 `productIo` 的编码护栏同量级 = 2 万） */
const PRODUCT_PAGE = 500;
const PRODUCT_MAX_PAGES = 40;

/**
 * 拉全量产品（只取款编码 + 款名）。
 *
 * 为什么要在本页拉全量：缺价清单是「产品库 − 有成本的款」，两边都不在本页的数据里。
 * 代价是 N 次分页 IPC —— 所以**只在挂载 / 页级刷新时跑一次**（保存进价后只重拉成本表，
 * 产品库不会因为写了一条成本而变）。
 */
async function loadProducts(): Promise<void> {
  const out: { code: string; name: string }[] = [];
  let truncated = false;
  try {
    for (let page = 0; page < PRODUCT_MAX_PAGES; page++) {
      const res = unwrapApi(
        await ipc.productList({
          offset: page * PRODUCT_PAGE,
          limit: PRODUCT_PAGE,
          search: '',
          status: '',
          supplierId: 0,
        })
      );
      for (const r of res?.rows ?? []) out.push({ code: r.code, name: r.name });
      if (out.length >= (res?.total ?? 0) || !(res?.rows ?? []).length) break;
    }
    truncated = out.length >= PRODUCT_MAX_PAGES * PRODUCT_PAGE;
  } catch {
    // 产品库读不到 → 缺价清单为空（不挡成本表本身）
  }
  products.value = out;
  productsTruncated.value = truncated;
}

async function loadCosts(): Promise<void> {
  costRows.value = unwrapApi(await ipc.aeCostMapList());
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    // ⚠️ 两件事**一起 await**：成本表（`loadCosts`）比缺价清单（`loadProducts`，要翻页拉全量产品）
    // 先就绪。分开 await 的话，界面会先渲染出成本表、缺价清单的位置还是空的 ——
    // 用户看到一屏"像加载完了"的界面，其实少了一块；`loading` 也不再能代表"这一页读完了"。
    await Promise.all([loadCosts(), loadProducts()]);
  } catch (e: unknown) {
    error.value = `读取成本表失败：${e instanceof Error ? e.message : '未知错误'}`;
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (busy.value) return;
  const code = draft.code.trim();
  const raw = draft.price.trim();
  if (!code) {
    toast('先选一个款（或填款编码）', 'error');
    return;
  }
  // 款编码必须在产品库里 —— 价是挂在款上的，编码写错这条价永远不会被任何订单取到，
  // 而成本表上它会看起来完全正常（只是多了一行没人用的价）。
  if (products.value.length && !products.value.some((p) => p.code === code)) {
    toast(`产品库里没有款编码「${code}」—— 请用「选款」挑一个`, 'error');
    return;
  }
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n < 0) {
    toast('进价要填不小于 0 的数字（元）', 'error');
    return;
  }
  const cents = Math.round(n * 100);

  busy.value = true;
  try {
    const r = unwrapApi(
      await ipc.aeCostMapUpsertManual({
        items: [{ styleCode: code, unitPriceCents: cents, effectiveFrom: draft.from }],
        effectiveFrom: draft.from,
      })
    );
    if (r.written === 0) {
      toast('与当前进价相同，没有写入（同样的价不需要再记一条）', 'info');
    } else {
      toast(`已保存 ${code} → ${yuan(cents)} 元，从 ${draft.from} 起生效`, 'success');
      draft.price = '';
    }
    await loadCosts();
  } catch (e: unknown) {
    toast(`保存失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    busy.value = false;
  }
}

function fill(row: { code: string }): void {
  draft.code = row.code;
  expanded.value = '';
}

function onPick(p: { code: string; name: string }): void {
  draft.code = p.code;
  pickerOpen.value = false;
}

async function confirmDelete(): Promise<void> {
  const r = pendingDelete.value;
  if (!r) return;
  busy.value = true;
  try {
    const out = unwrapApi(
      await ipc.aeCostMapDeleteManual({
        keys: [{ styleCode: String(r.styleCode), effectiveFrom: String(r.effectiveFrom) }],
      })
    );
    toast(
      out.deleted
        ? `已删除 ${r.styleCode} 在 ${r.effectiveFrom} 的那条进价`
        : '那条已经不在了（可能已被删除）',
      out.deleted ? 'success' : 'info'
    );
    pendingDelete.value = null;
    await loadCosts();
  } catch (e: unknown) {
    toast(`删除失败：${e instanceof Error ? e.message : '未知错误'}`, 'error');
  } finally {
    busy.value = false;
  }
}

watch(
  () => props.refreshNonce,
  () => {
    void load();
  }
);

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="ct">
    <p v-if="error" class="wb-notice wb-notice--error">{{ error }}</p>

    <!-- 两栏：左=行动区（录入 + 待补），右=现状表。
         ⭐ 这一页唯一的动线是 **缺 → 有**（补进价），两栏就是它的两端。 -->
    <div class="ct-cols">
      <div class="ct-aside">
        <!-- ① 录入 / 改价 —— 全页唯一的主动作（页面上只有这一个 primary 按钮） -->
        <section class="wb-panel ct-entry">
          <div class="wb-panel__head">
            <span>录入 / 修改进价</span>
          </div>
          <div class="ct-entry__body">
            <label class="wb-field">
              <span class="wb-field__label">款</span>
              <span class="ct-pick">
                <input
                  v-model="draft.code"
                  class="wb-input"
                  data-act="cost-code"
                  placeholder="款编码"
                  aria-label="款编码"
                />
                <button
                  class="wb-btn wb-btn--sm"
                  type="button"
                  data-act="cost-pick"
                  @click="pickerOpen = true"
                >
                  选款
                </button>
              </span>
            </label>
            <!-- 回显：填了编码就当场说清"这是哪个款、现在的价是多少、从哪来"。
                 放在「款」的正下方 —— 它解释的正是上面那一格。 -->
            <p v-if="echo" class="ct-echo" data-act="cost-echo">{{ echo }}</p>

            <div class="ct-entry__pair">
              <label class="wb-field">
                <span class="wb-field__label">进价（元）</span>
                <input
                  v-model="draft.price"
                  class="wb-input"
                  data-act="cost-price"
                  placeholder="如 12.34"
                  aria-label="进价（元）"
                />
              </label>
              <label class="wb-field">
                <span class="wb-field__label">生效日</span>
                <input
                  v-model="draft.from"
                  class="wb-input"
                  data-act="cost-from"
                  type="date"
                  aria-label="生效日"
                />
              </label>
            </div>

            <button
              class="wb-btn wb-btn--primary ct-entry__save"
              type="button"
              data-act="cost-save"
              :disabled="busy"
              @click="save"
            >
              {{ busy ? '保存中…' : '保存进价' }}
            </button>
          </div>
          <div class="wb-panel__foot ct-entry__note">
            改价会新增一条「从生效日起」的区间 —— 历史订单仍按各自下单时的价算
          </div>
        </section>

        <!-- ② 缺价清单（可操作待办）——
             ⭐ 相对「导入模板」的独有价值：导入不会告诉你**哪些款漏了**。 -->
        <section v-if="missing.length" class="wb-panel ct-todo">
          <div class="wb-panel__head">
            <span>还没维护进价的款</span>
            <span class="ct-badge">{{ missing.length }}</span>
          </div>
          <div class="wb-panel__body ct-todo__body">
            <p class="ct-hint">这些款在算钱 / 拣货里算不出金额。点一行把它带进上面的录入框。</p>
            <ul class="ct-missing" data-act="cost-missing">
              <li v-for="m in missing.slice(0, MISSING_SHOWN)" :key="m.code" class="ct-missing__row">
                <button
                  class="ct-missing__pick"
                  type="button"
                  :data-act="`cost-fill-${m.code}`"
                  :title="`把 ${m.code} 带进录入框`"
                  @click="fill(m)"
                >
                  <span class="wb-mono ct-missing__code">{{ m.code }}</span>
                  <span class="ct-missing__name">{{ m.name || '—' }}</span>
                  <span class="ct-missing__go">填进价</span>
                </button>
              </li>
            </ul>
            <p v-if="missing.length > MISSING_SHOWN" class="ct-hint ct-todo__more">
              只列出前 {{ MISSING_SHOWN }} 个（共 {{ missing.length }} 个）
            </p>
          </div>
          <div v-if="productsTruncated" class="wb-panel__foot ct-trunc" data-act="cost-truncated">
            产品超过 2 万款，清单只覆盖前 2 万
          </div>
        </section>
        <!-- 没有待办时也要给一句**结论**：一片空白读不出"是都补完了，还是没读到产品库" -->
        <p v-else-if="products.length" class="ct-allset">产品库里的 {{ products.length }} 个款都已维护进价</p>
      </div>

      <!-- ③ 款级成本表 -->
      <section class="wb-panel ct-list">
        <div class="wb-panel__head">
          <span>款级进价</span>
          <span class="wb-muted ct-sub">{{ styleRows.length }} 个款 · {{ costRows.length }} 条区间</span>
          <input
            v-model="search"
            class="wb-input wb-input--sm ct-search"
            data-act="cost-search"
            placeholder="按款编码 / 款名过滤…"
            aria-label="过滤成本表"
          />
        </div>
        <div class="wb-panel__body">
          <div class="wb-table-wrap">
            <table v-if="!loading" class="wb-table" data-act="cost-table">
              <thead>
                <tr>
                  <th class="ct-c-exp"><span class="wb-muted" aria-hidden="true">▸</span></th>
                  <th>款编码</th>
                  <th>款名</th>
                  <th class="wb-num">当前进价</th>
                  <th>来源</th>
                  <th>生效日</th>
                  <th class="wb-num">区间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <template v-for="r in filteredRows" :key="r.code">
                  <tr class="is-clickable" :data-cost-code="r.code">
                    <td class="ct-c-exp">
                      <button
                        class="ct-caret"
                        type="button"
                        data-act="cost-row-expand"
                        :aria-expanded="expanded === r.code"
                        :aria-label="`展开 ${r.code} 的进价区间`"
                        @click="expanded = expanded === r.code ? '' : r.code"
                      >
                        {{ expanded === r.code ? '▾' : '▸' }}
                      </button>
                    </td>
                    <td class="wb-mono ct-c-code" data-act="cost-code-cell">{{ r.code }}</td>
                    <!-- 款名是弹性列：过长就省略号，全文留在 `title` 里（裁了也得查得到） -->
                    <td class="ct-c-name" :title="r.name || ''">
                      <span :class="{ 'wb-muted': !r.name }">{{ r.name || '—' }}</span>
                    </td>
                    <!-- ⚠️ `cost-current` 的文本必须**恰好**是数字（冒烟按 `12.34` 全等比）——
                         「元」挂在它外面的兄弟 span 上，不能合进去。 -->
                    <td class="wb-num ct-c-price">
                      <span v-if="r.current" class="ct-price">
                        <span data-act="cost-current">{{ Number(r.current.unitPrice).toFixed(2) }}</span>
                        <span class="ct-unit">元</span>
                      </span>
                      <span v-else class="wb-muted" data-act="cost-current">—</span>
                    </td>
                    <td data-act="cost-source">
                      <span
                        v-if="r.current"
                        class="wb-tag ct-src"
                        :class="{ 'is-on': r.current.source === 'manual' }"
                      >
                        {{ sourceLabel(r.current.source) }}
                      </span>
                      <span v-else class="wb-muted">—</span>
                    </td>
                    <td class="wb-mono wb-muted ct-c-date">
                      {{ r.current ? r.current.effectiveFrom : '—' }}
                    </td>
                    <td class="wb-num">
                      <span class="ct-chip">{{ r.intervals.length }}</span>
                    </td>
                    <td class="ct-c-ops">
                      <button class="wb-link" type="button" data-act="cost-edit" @click="fill(r)">
                        改价
                      </button>
                    </td>
                  </tr>
                  <tr v-if="expanded === r.code" class="ct-drow" :data-cost-detail="r.code">
                    <td :colspan="8">
                      <div class="ct-ivwrap">
                        <div class="ct-ivhead">
                          <span>生效区间</span>
                          <span class="wb-muted">
                            {{ r.intervals.length }} 条 · 按生效日从早到晚 · 越靠下越新
                          </span>
                        </div>
                        <table class="wb-table ct-iv">
                          <thead>
                            <tr>
                              <th class="ct-iv__flag" />
                              <th>生效日</th>
                              <th class="wb-num">单价（元）</th>
                              <th>来源</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            <tr
                              v-for="iv in r.intervals"
                              :key="`${iv.effectiveFrom}|${iv.source}`"
                              :class="{ 'is-current': isCurrentInterval(r, iv) }"
                            >
                              <!-- 哪条正在生效：改版前要用户自己按日期推 -->
                              <td class="ct-iv__flag">
                                <span v-if="isCurrentInterval(r, iv)" class="wb-tag is-on">当前</span>
                              </td>
                              <td class="wb-mono">
                                {{ iv.effectiveFrom === '0000-01-01' ? '（最早）' : iv.effectiveFrom }}
                              </td>
                              <td class="wb-num">{{ yuan(iv.unitPriceCents) }}</td>
                              <td class="wb-muted">{{ sourceLabel(iv.source) }}</td>
                              <td class="ct-iv__ops">
                                <!-- 拿货对账的行不可删：删了下次落账同步会原样回来（用户在"删不掉"里打转） -->
                                <button
                                  v-if="iv.source === 'manual'"
                                  class="wb-link wb-link--danger"
                                  type="button"
                                  data-act="cost-iv-delete"
                                  @click="pendingDelete = iv"
                                >
                                  删除
                                </button>
                                <span v-else class="wb-muted" title="拿货对账自动同步的价，改它请改拿货单">
                                  —
                                </span>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                        <p class="wb-muted ct-hint">
                          删掉一条后它不再生效；这款若还有更早的价或拿货价，会回落到那一条。
                        </p>
                      </div>
                    </td>
                  </tr>
                </template>
                <tr v-if="!filteredRows.length && !loading">
                  <td colspan="8" class="ct-emptycell">
                    <div class="wb-empty" data-act="cost-empty">
                      <div class="wb-empty__icon" aria-hidden="true">￥</div>
                      <div class="wb-empty__title">
                        {{ search ? '没有匹配的款' : '还没有任何进价' }}
                      </div>
                      <p class="wb-empty__desc">
                        {{
                          search
                            ? '换个款编码或款名再试。'
                            : '用左边的录入框填一个，或去产品页用导入模板按款批量补。'
                        }}
                      </p>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="loading" class="ct-hint ct-loading">读取中…</p>
        </div>
      </section>
    </div>

    <ProductPicker v-if="pickerOpen" title="选择要维护进价的款" @close="pickerOpen = false" @pick="onPick" />

    <ConfirmDialog
      v-if="pendingDelete"
      title="删除这条进价"
      confirm-text="确认删除"
      busy-text="删除中…"
      :busy="busy"
      @close="pendingDelete = null"
      @confirm="confirmDelete"
    >
      <p>
        将删除
        <b class="wb-mono">{{ pendingDelete.styleCode }}</b>
        在 <b class="wb-mono">{{ pendingDelete.effectiveFrom }}</b> 生效的那条进价
        （{{ yuan(pendingDelete.unitPriceCents) }} 元）。
      </p>
      <p class="wb-notice wb-notice--warn">
        删除后这条不再生效。这款若还有更早的价或拿货对账同步来的价，会回落到那一条 ——
        订单金额会跟着变，请确认这就是你要的。
      </p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.ct {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ---- 两栏：左=行动区（录入 + 待补），右=现状表 ----------------------------
   左栏给 340px 定宽（不是百分比）：这一栏的内容是**表单**，宽度再变不会多出信息，
   反而会从"两列并排的进价/生效日"退回一列。剩下全给表 —— 表列多，宽一点更合适。 */
.ct-cols {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 340px) minmax(0, 1fr);
  gap: 12px;
}

.ct-aside {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.ct-entry {
  flex-shrink: 0;
}
.ct-entry__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
}
.ct-pick {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ct-pick .wb-input {
  flex: 1;
  min-width: 0;
}
/* 进价 / 生效日并排：两个字段都是短值，各占一半比各占一整行好读 */
.ct-entry__pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}
/* 主动作给满宽 + 比基座高一档（30px）：这是整页唯一会写库的按钮，
   它不该和旁边的「选款」看起来一样重。 */
.ct-entry__save {
  height: 30px;
}
.ct-entry__note {
  font-size: 12px;
  line-height: 1.55;
  color: var(--wb-text-muted);
  background: var(--wb-surface-2);
}
/* 回显条：接在「款」那一格下面 —— 它解释的就是上面填的那个编码 */
.ct-echo {
  margin: -2px 0 0;
  padding-left: 8px;
  border-left: 2px solid var(--wb-border-strong);
  font-size: 12px;
  line-height: 1.55;
  color: var(--wb-text-muted);
}

/* ---- 待补清单 -------------------------------------------------------------
   整行是**按钮**（一次点击带进录入框）。改版前是一行灰字 + 右侧一个文字链接，
   点在名字上没有任何反应 —— 一行里只有 4 个字的可点区，而用户的意图是"就这一款"。 */
.ct-todo {
  flex: 1;
  min-height: 140px;
}
.ct-todo__body {
  padding: 10px 12px;
}
.ct-badge {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.ct-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}
.ct-trunc {
  font-size: 12px;
  color: var(--wb-text-muted);
}
.ct-allset {
  margin: 0 0 0 2px;
  font-size: 12px;
  color: var(--wb-text-muted);
}
.ct-missing {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.ct-missing__row + .ct-missing__row {
  border-top: 1px dashed var(--wb-border);
}
.ct-missing__pick {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  font: inherit;
  font-size: 12px;
  color: var(--wb-text);
  text-align: left;
  cursor: pointer;
}
.ct-missing__pick:hover {
  background: var(--wb-hover);
}
.ct-missing__pick:hover .ct-missing__go {
  color: var(--wb-primary);
  text-decoration: underline;
}
.ct-missing__code {
  flex-shrink: 0;
}
.ct-missing__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--wb-text-muted);
}
.ct-missing__go {
  flex-shrink: 0;
  color: var(--wb-primary);
}
.ct-todo__more {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--wb-border);
}

/* ---- 款级进价表 ----------------------------------------------------------- */
.ct-list {
  min-height: 180px;
}
.ct-sub {
  font-weight: 400;
}
.ct-search {
  margin-left: auto;
  width: 200px;
}
.ct-c-exp {
  width: 30px;
}
.ct-caret {
  border: none;
  background: none;
  padding: 2px 4px;
  font: inherit;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.ct-caret:hover {
  color: var(--wb-text);
}
.ct-c-code {
  width: 1%;
  white-space: nowrap;
}
/* 款名弹性列：吃掉剩余宽度，过长省略号（全文在 title 里） */
.ct-c-name {
  max-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ct-c-date {
  font-size: 12px;
}
/* 当前进价 = 这一页的主数字：加粗 + 加大，数量级一眼可比（tabular-nums 由 .wb-num 给） */
.ct-price {
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text);
}
.ct-unit {
  margin-left: 2px;
  font-size: 12px;
  font-weight: 400;
  color: var(--wb-text-muted);
}
/* 来源标签：左边一个小圆点，靠颜色区分手工 / 拿货 —— 两个都只是灰底时就只能读字 */
.ct-src::before {
  content: '';
  width: 5px;
  height: 5px;
  margin-right: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.75;
}
.ct-chip {
  display: inline-block;
  min-width: 20px;
  padding: 1px 6px;
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface-2);
  font-size: 12px;
  color: var(--wb-text-muted);
}
.ct-c-ops {
  text-align: right;
}

/* ---- 展开区 ---------------------------------------------------------------
   与产品页展开区同一套语言：surface-2 的井里浮起一张**白卡**，块与块的边界不靠猜。 */
.ct-drow > td {
  padding: 0;
  background: var(--wb-surface-2);
  /* ⚠️ 必须恢复 normal —— 展开区住在 .wb-table 的 td 里，而基座给 td 定了 nowrap，
     不恢复的话说明文字会一行顶出去、被 .wb-panel 的 overflow:hidden 静默裁掉。 */
  white-space: normal;
}
.ct-ivwrap {
  margin: 10px;
  padding: 10px 12px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface);
}
.ct-ivhead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--wb-border);
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
}
.ct-iv {
  width: 100%;
}
.ct-iv__flag {
  width: 1%;
  white-space: nowrap;
}
/* 正在生效那一行：整行浅底 + 首列的行内竖条（与基座 `tr.is-on` 同一套表达） */
.ct-iv tbody tr.is-current {
  background: var(--wb-primary-soft);
}
.ct-iv tbody tr.is-current td:first-child {
  box-shadow: inset 2px 0 0 var(--wb-primary);
}
.ct-iv__ops {
  text-align: right;
}
.ct-emptycell {
  padding: 0;
  white-space: normal;
}
.ct-loading {
  padding: 12px 14px;
}

/* ---- 窄窗口：两栏改上下堆叠（左在上）--------------------------------------
   ⚠️ 与 `GoodsWorkbenchView` 同一组坑，三条缺一不可：
   ① 行高写 `max-content`（不是 `auto`）：子栏都带 `min-height: 0`，`auto` 轨道的基准 = 0，
      网格会把富余高度**均分**给两行而不是按内容定高 ⇒ 每行比内容矮、内容溢出自己的盒子，
      而 `.wb-panel` 是 `overflow: hidden` ⇒ 被静默裁掉（没有滚动条、不报错）。
   ② `align-content: start`：默认 stretch 会把两行摊开、每块拉到半屏高，中间撑出大片空白。
   ③ 容器内 `flex: 1` 的子元素在"高度由内容决定"的场景下要改回 `flex: none`：
      `flex: 1` 的 basis 是 0，固有高度≈0，格子跟着塌。`.wb-panel__body` 同理（它也是 flex:1），
      并给一个 `max-height` —— 内容短就长到内容，长过 60vh 才在自己内部滚。 */
@media (max-width: 1180px) {
  .ct-cols {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: max-content max-content;
    align-content: start;
    overflow: auto;
  }
  /* ⚠️ 只改**子栏内部**的 flex：`.ct` 自己是 `.gd-tabpanel` 的 flex 项，它必须继续
     `flex: 1`（高度由外部给定 ⇒ `.ct-cols` 才有定高 ⇒ 上面那句 overflow:auto 才有意义）。
     塌掉的只会是"高度改由内容决定"之后、basis 为 0 的那些（`.ct-todo` / `.wb-panel__body`）。 */
  .ct-todo {
    flex: none;
    min-height: 0;
  }
  .ct-todo__body {
    flex: none;
    max-height: 45vh;
    overflow: auto;
  }
  .ct-list .wb-panel__body {
    flex: none;
    max-height: 60vh;
    overflow: auto;
  }
}
</style>
