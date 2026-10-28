<script setup lang="ts">
// src/modules/shop-accounts/components/ShipRateQuoteTab.vue
// 「物流运费 › 运费查询」（2026-10-15 由岛 dist/views/quote.js 迁入）。
// 输入实际克重 → 逐国列出实际运费（按金额升序，宿主排的）。
//
// 重绘策略（岛时代的硬要求，Vue 化后由响应式天然保证，注释保留以防回退）：
//   · 克重 / 筛选是输入 → **不许整体重绘**（无框架时代整体重绘会丢光标与输入法组合态，
//     症状是"克重框里打字打不进去"且不报错）；
//   · 类别 / 变体 / 取整是按钮或下拉 → 变化后重算。
//
// 本组件**不做任何算术**：金额、档位、费用构成一律来自 store（宿主 op 返回值）。
import { computed, onMounted, ref, watch } from 'vue';
import { useShipRateStore } from '../shipRateStore';
import {
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  MODE_LABELS,
  ROUNDING_LABELS,
  breakdownText,
  categoryLabel,
  currencyText,
  gramsText,
  money,
  rangeText,
} from '../shipRateFormat';
import type { QuoteRow } from '@/lib/shipRateQuote';
import type { RateCard } from '@/lib/shipRate';

const store = useShipRateStore();

/**
 * 有价行（card 非空）与拒算行合并保序的视图列表。
 * 宿主保证 ok=true 的行必有 card；打 kind 标签让模板的 v-if/v-else 能收窄联合类型，
 * 有价行里不必到处写 `r.card &&`（null 分支在 fail 行里单独处理）。
 */
type ViewRow = QuoteRow & { card: RateCard };
type FailItem = { kind: 'fail'; row: QuoteRow };
type OkItem = { kind: 'ok'; row: ViewRow };
const viewRows = computed<Array<FailItem | OkItem>>(() =>
  store.filteredResults.map((r) =>
    r.ok && r.card ? { kind: 'ok', row: r as ViewRow } : { kind: 'fail', row: r },
  ),
);

/** 本页的"计算中"（只反映用户在本页触发的重算；导入等后台动作不算） */
const busy = ref(false);

/** 克重输入防抖（岛时代 220ms；防的是每敲一位就问一次宿主） */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function onWeightInput(v: string): void {
  store.setWeight(v);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void requote();
  }, 220);
}

async function requote(): Promise<void> {
  busy.value = true;
  try {
    await store.refreshQuote();
  } finally {
    busy.value = false;
  }
}

/** 运价表里出现过的全部变体（当前只有乌克兰的非普货：其他仓 / 香港仓） */
const allVariants = computed(() => {
  const set = new Set<string>();
  for (const c of store.table ? store.table.countries : []) {
    for (const card of c.cards) if (card.variant) set.add(card.variant);
  }
  return [...set].sort();
});

/** 无运价表时的空状态 */
const noTable = computed(() => !store.hasTable);

/** 结果是否针对当前克重（false 时表格显示的是旧结果，避免误读） */
const stale = computed(() => store.resultWeight !== store.weight);

/** 全表都算不出价、且原因都是"未接汇率"时的提示（否则用户会以为是自己克重输错了） */
const currencyNotice = computed(() => {
  const s = store.resultStats;
  if (s.ok > 0 || !s.refused || s.noPrice) return '';
  const cur = store.table && store.table.stats ? store.table.stats.currencies : [];
  return `当前工作表的报价币种是 ${cur.map(currencyText).join(' / ') || '非人民币'}，本版尚未接入汇率，因此不给出金额（按人民币直接算会差出数倍，且看不出错）。计费口径、档位、最低计费重量都已在下方逐国列出，可切回人民币线路查看实际运费。`;
});

async function importTable(): Promise<void> {
  await store.importByDialog();
}

// 类别 / 变体 / 取整变化 → 立刻重算（这三样不是"打字"，不需要防抖）
watch(
  () => [store.category, store.variant, store.rounding],
  () => {
    void requote();
  },
);

onMounted(() => {
  // 仅当结果与当前克重不一致时才算一次（pane 的 init/resync 通常已经算过了）
  if (store.hasTable && store.resultWeight !== store.weight) void requote();
});
</script>

<template>
  <div class="srq">
    <!-- 工具条 -->
    <section class="wb-panel srq__toolbar">
      <div class="wb-panel__body srq__toolbar-body">
        <label class="wb-field">
          <span class="wb-field__label">实际克重</span>
          <span class="srq__inline">
            <input
              class="wb-input srq__w92"
              data-act="ship-weight"
              type="number"
              min="1"
              step="1"
              :value="store.weight || ''"
              aria-label="实际克重"
              @input="onWeightInput(($event.target as HTMLInputElement).value)"
            />
            <span class="wb-muted srq__unit">g</span>
          </span>
        </label>

        <div class="wb-field">
          <span class="wb-field__label">计费类别</span>
          <div class="wb-seg">
            <button
              v-for="o in CATEGORY_OPTIONS"
              :key="o.value"
              type="button"
              class="wb-seg__item"
              :data-act="`ship-cat-${o.value}`"
              :class="{ 'is-on': store.category === o.value }"
              @click="store.setCategory(o.value)"
            >
              {{ o.label }}
            </button>
          </div>
        </div>

        <label v-if="allVariants.length" class="wb-field">
          <span class="wb-field__label">仓库变体</span>
          <select
            class="wb-input"
            data-act="ship-variant"
            :value="store.variant"
            @change="store.setVariant(($event.target as HTMLSelectElement).value)"
          >
            <option value="">不限</option>
            <option v-for="v in allVariants" :key="v" :value="v">{{ v }}</option>
          </select>
        </label>

        <label class="wb-field">
          <span class="wb-field__label">取整</span>
          <select
            class="wb-input"
            data-act="ship-rounding"
            :value="store.rounding"
            @change="store.setRounding(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="(label, key) in ROUNDING_LABELS" :key="key" :value="key">{{ label }}</option>
          </select>
        </label>

        <label class="wb-field srq__grow">
          <span class="wb-field__label">筛选</span>
          <input
            class="wb-input"
            data-act="ship-filter"
            type="search"
            placeholder="国家 / 英文名 / Code"
            :value="store.filter"
            @input="store.setFilter(($event.target as HTMLInputElement).value)"
          />
        </label>

        <button
          class="wb-btn"
          type="button"
          data-act="ship-copy-all"
          :disabled="!store.results.some((r) => r.ok)"
          @click="store.copyAll()"
        >
          复制全部
        </button>
      </div>
    </section>

    <!-- 结果区 -->
    <section class="wb-panel srq__results">
      <div v-if="noTable" class="wb-panel__body">
        <div class="wb-empty" data-act="ship-empty">
          <div class="srq__empty-title">还没有运价表</div>
          <p class="wb-muted">
            导入物流报价单 Excel：自动识别报价单所在的工作表（优先「无忧物流-标准」），之后输入实际克重即可算出到每个国家的运费。
          </p>
          <button class="wb-btn wb-btn--primary" type="button" data-act="ship-import" @click="importTable">
            导入运价表
          </button>
        </div>
      </div>

      <template v-else>
        <div v-if="!(store.weight > 0)" class="wb-panel__body">
          <div class="wb-empty srq__empty-sm">请输入大于 0 的克重</div>
        </div>

        <template v-else>
          <div v-if="currencyNotice" class="wb-panel__body">
            <p class="wb-notice wb-notice--warn">{{ currencyNotice }}</p>
          </div>

          <div class="wb-panel__body srq__summary" data-act="ship-summary">
            <span class="wb-tag">共 <b>{{ store.resultStats.total }}</b> 国</span>
            <span class="wb-tag is-on">有价 <b>{{ store.resultStats.ok }}</b></span>
            <span v-if="store.resultStats.noPrice" class="wb-tag is-warn">该克重无价 <b>{{ store.resultStats.noPrice }}</b></span>
            <span v-if="store.resultStats.refused" class="wb-tag is-warn">未接汇率 <b>{{ store.resultStats.refused }}</b></span>
            <span v-if="store.filter.trim()" class="wb-tag">筛出 <b>{{ store.filteredResults.length }}</b></span>
            <span class="wb-muted srq__meta">
              {{ gramsText(store.weight) }} · {{ categoryLabel(store.category) }} ·
              {{ ROUNDING_LABELS[store.rounding] || store.rounding }}
              <span v-if="stale"> · 结果对应上一次克重</span>
              <span v-if="busy"> · 计算中…</span>
            </span>
          </div>

          <!-- 表格容器：`.srq__table-body` 承担伸缩 + 内部滚动（见 style 里的高度链说明） -->
          <div class="wb-panel__body srq__table-body">
            <div v-if="!viewRows.length" class="wb-empty srq__empty-sm">没有匹配的国家</div>
            <div v-else class="wb-table-wrap">
              <table class="wb-table" data-act="ship-quote-table">
                <thead>
                  <tr>
                    <th class="wb-num">#</th>
                    <th>国家/地区</th>
                    <th>Code</th>
                    <th>类别</th>
                    <th>档位</th>
                    <th>模式</th>
                    <th>费用构成</th>
                    <th class="wb-num">运费(元)</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="(item, i) in viewRows" :key="`${item.row.code}-${item.row.nameCn}-${i}`">
                    <tr v-if="item.kind === 'fail'" class="srq__row-fail">
                      <td class="wb-num">{{ i + 1 }}</td>
                      <td class="srq__nowrap">
                        {{ item.row.nameCn
                        }}<span v-if="item.row.card" class="wb-tag is-warn">{{ currencyText(item.row.card.currency) }}</span>
                      </td>
                      <td class="wb-mono wb-muted srq__nowrap">{{ item.row.code || '—' }}</td>
                      <td colspan="5" class="wb-muted">
                        {{ item.row.reason
                        }}<span v-if="item.row.candidates && item.row.candidates.length">
                          · 该国可用档位：{{ item.row.candidates.map((c) => rangeText(c.minG, c.maxG)).join('、') }}</span
                        >
                      </td>
                      <td></td>
                    </tr>
                    <tr v-else>
                      <td class="wb-num">{{ i + 1 }}</td>
                      <td class="srq__nowrap">
                        {{ item.row.nameCn
                        }}<span v-if="item.row.variant" class="wb-tag">{{ item.row.variant }}</span>
                      </td>
                      <td class="wb-mono wb-muted srq__nowrap">{{ item.row.code || '—' }}</td>
                      <td class="srq__nowrap">{{ item.row.category ? (CATEGORY_LABELS[item.row.category] || item.row.category) : '—' }}</td>
                      <td class="wb-muted srq__nowrap">
                        {{ rangeText(item.row.card.minG, item.row.card.maxG)
                        }}<span v-if="item.row.card.minChargeG > 0" class="wb-tag">{{ gramsText(item.row.card.minChargeG) }} 起计</span>
                      </td>
                      <td class="wb-muted">{{ MODE_LABELS[item.row.card.mode] || item.row.card.mode }}</td>
                      <td class="wb-muted">{{ breakdownText(item.row) }}</td>
                      <td class="wb-num srq__strong">{{ money(item.row.fee) }}</td>
                      <td>
                        <button
                          class="wb-btn wb-btn--sm"
                          type="button"
                          :data-act="`ship-copy-row-${i}`"
                          title="复制本行"
                          @click="store.copyRow(i)"
                        >
                          复制
                        </button>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* 高度链（2026-10-15 修）：本页曾出现"DOM 里表格完好、页面却一片空白"。
   根因是这一层只有 `display:flex`，**没有高度约束**：
 *     .srq（内容自然高 8036px：184 国表格全渲染）→ .srp__body（`flex:1` 但父高已定 ⇒ 只占 773px）
 *     → .srq__results（.wb-panel 是 flex column）内部两个 .wb-panel__body 都是 `flex:1 1 0%`
 *     ⇒ **平分那 8036px**：summary 拿到 3982px，它是 row 布局 + align-items:center
 *     ⇒ 那行"共 184 国"的标签被垂直居中到 y≈2162，视口只有 913 ⇒ 整个可见区全是空白。
 * 表格本身其实在 y=4153，离视口 4.5 倍高，而祖先 overflow:hidden 又不让文档滚。
 * 教训（与铁律同源）：**`flex:1` 只在祖先给出确定高度时才是"伸缩"，否则是"平分内容"**。
 * 契约与 CostPane.vue §ct 相同：根 `flex:1 + min-height:0`，固定区 `flex-shrink:0`，
 * 唯一可伸缩的是结果面板，且它的 overflow 交给内部表格容器滚动。 */
.srq {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
/* 工具条是输入区：固定不压缩（被压扁会让分段控件与下拉换行） */
.srq__toolbar {
  flex-shrink: 0;
}
.srq__results {
  flex: 1;
  min-height: 0;
}
.srq__toolbar-body {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px 14px;
}
.srq__inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.srq__w92 {
  width: 92px;
}
.srq__unit {
  font-size: 12px;
}
.srq__grow {
  flex: 1 1 180px;
  min-width: 160px;
}
/* summary 不参与伸缩：它只有一行高度。
   宿主 .wb-panel__body 的 `flex:1` 会让它在超高容器里被平分成几千 px，
   又因为这行是 `align-items:center` 而把标签推到容器正中 —— 必须显式收回 auto。 */
.srq__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
/* 表格容器占满结果面板剩余高度并自己滚动；max-height:0 是让 flex 子项能真正收缩的经典写法 */
.srq__table-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  /* 内容（184 行）绝不能把面板撑高 */
  overflow: hidden;
}
.srq__table-body > * {
  flex: 1 1 auto;
  min-height: 0;
}
.srq__meta {
  font-size: 12px;
}
.srq__empty-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 6px;
}
.srq__empty-sm {
  padding: 18px 0;
  font-size: 12.5px;
}
.srq__row-fail td {
  color: var(--wb-text-muted);
}
.srq__nowrap {
  white-space: nowrap;
}
.srq__strong {
  font-weight: 600;
}
</style>
