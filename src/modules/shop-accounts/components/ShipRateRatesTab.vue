<script setup lang="ts">
// src/modules/shop-accounts/components/ShipRateRatesTab.vue
// 「物流运费 › 运价表」（2026-10-15 由岛 dist/views/rates.js 迁入）。
// 运价来源 / 导入更新 / 换 sheet / 分节结构 / 逐国价卡明细 / 告警。
//
// 这是"数据可变更"需求的落点：Excel 换版后不必改代码，在这里重新导入即可。
// 归一化后的运价表真源在**宿主快照**（sr_rate_snapshots），源文件移动/删除后依然能算。
//
// 两个别改的行为：
//   ① 导入失败时要列出**已体检的工作表张数与各自国家数**，并可手动指定任意一张 ——
//      被一句"结构无法识别"堵死，用户只能猜是哪张表的问题（报价单是 21 张拼一本的）；
//   ② 逐国价卡展开用的是 nameCn 做键（ISO code 可能为空串，nameCn 不会）。
import { computed, ref } from 'vue';
import { useShipRateStore } from '../shipRateStore';
import {
  CATEGORY_LABELS,
  categoriesText,
  currencyText,
  gramsText,
  money,
  rangeText,
} from '../shipRateFormat';
import type { RateCard, CountryRate } from '@/lib/shipRate';

const store = useShipRateStore();

/** 展开状态（模块级：切走再切回不丢，与岛时代 app.store['rates'] 同语义） */
const expanded = ref<Set<string>>(new Set());
const filter = ref('');

function toggle(nameCn: string): void {
  if (expanded.value.has(nameCn)) expanded.value.delete(nameCn);
  else expanded.value.add(nameCn);
  expanded.value = new Set(expanded.value); // 触发响应式
}

/** sheet 名 → 体检结果（没有体检数据时退化为只显示名字） */
const candidateMap = computed(() => {
  const m = new Map<string, { countries: number; cards: number; sections: number; reason: string }>();
  for (const c of store.candidates) {
    if (c && c.sheetName) m.set(c.sheetName, c);
  }
  return m;
});

/** 下拉项文案：体检过就带上国家数，"非报价单"的表也要显式标出来，免得用户逐个试 */
function sheetLabel(name: string): string {
  const c = candidateMap.value.get(name);
  if (!c) return name;
  return c.countries > 0 ? `${name}（${c.countries} 国）` : `${name}（非报价单）`;
}

/** 国家表按过滤词筛选（中文名 / 英文名 / Code） */
const filteredCountries = computed<CountryRate[]>(() => {
  const q = filter.value.trim().toLowerCase();
  const list = store.countriesSorted;
  if (!q) return list;
  return list.filter(
    (c) =>
      c.nameCn.toLowerCase().includes(q) ||
      c.nameEn.toLowerCase().includes(q) ||
      c.code.toLowerCase().includes(q),
  );
});

/** 单张价卡的明细文本（两种模式的科目不同） */
function cardDetail(card: RateCard): string {
  return card.mode === 'firstStep'
    ? `首重 ${money(card.firstFee)} 元/包 + 续重 ${money(card.stepFee)} 元/${card.stepG || 500}g`
    : `配送 ${money(card.ratePerKg)} 元/KG + 挂号 ${money(card.registerFee)} 元/包`;
}

/** 当前来源的 sheet 名（切换下拉的选中项回显用） */
const currentSheet = computed(() => (store.source && store.source.sheetName) || (store.table && store.table.sheetName) || '');

/** 非人民币报价的币种（有就要明确提示：这些线路会拒算而不是按人民币估算） */
const nonCny = computed(() => {
  const curs = (store.table && store.table.stats ? store.table.stats.currencies : []) as string[];
  return curs.filter((c) => c !== 'CNY');
});

async function importTable(): Promise<void> {
  await store.importByDialog();
}

/** 切换工作表（有表：针对当前来源文件；无表：针对刚打开过的 lastFile） */
async function onSheetChange(name: string): Promise<void> {
  if (!name) return;
  const path = store.hasTable ? '' : (store.lastFile && store.lastFile.filePath) || '';
  await store.switchSheet(name, path);
}

/** 导入失败后从候选里手动指定：明确针对 lastFile，不碰 source */
async function useCandidate(sheet: string): Promise<void> {
  const filePath = (store.lastFile && store.lastFile.filePath) || '';
  await store.switchSheet(sheet, filePath);
}
</script>

<template>
  <div class="srr">
    <!-- ── 运价来源 ─────────────────────────────────────────────── -->
    <section v-if="!store.hasTable" class="wb-panel srr__fixed" data-act="ship-source">
      <div class="wb-panel__head"><span>运价来源</span></div>
      <div class="wb-panel__body">
        <div class="wb-empty" data-act="ship-empty">
          <div class="srr__empty-title">还没有运价表</div>
          <p class="wb-muted">
            选择物流报价单 Excel：会自动找出报价单所在的工作表（优先「无忧物流-标准」），挑不准时可在下方手动指定。解析与计价都在本地完成，数据只存在本机。
          </p>
          <button class="wb-btn wb-btn--primary" type="button" data-act="ship-import" @click="importTable">
            导入运价表
          </button>
        </div>

        <p v-if="store.lastFile" class="wb-muted srr__tried">
          上次选择「{{ store.lastFile.fileName }}」：已体检 {{ store.sheetNames.length }} 张工作表<template
            v-if="store.usableCandidates.length"
          >，其中 {{ store.usableCandidates.length }} 张可用</template
          ><template v-else>，没有任何一张是报价单结构</template>。
        </p>
        <div v-if="store.usableCandidates.length" class="srr__bar">
          <button
            v-for="c in store.usableCandidates"
            :key="c.sheetName"
            class="wb-btn wb-btn--sm"
            type="button"
            data-act="ship-use-sheet"
            :data-sheet="c.sheetName"
            @click="useCandidate(c.sheetName)"
          >
            用「{{ c.sheetName }}」· {{ c.countries }} 国
          </button>
        </div>
        <label v-if="store.lastFile && store.sheetNames.length > 1" class="wb-field srr__manual">
          <span class="wb-field__label">手动指定工作表</span>
          <select
            class="wb-input"
            data-act="ship-sheet-manual"
            @change="onSheetChange(($event.target as HTMLSelectElement).value)"
          >
            <option value="">选择…</option>
            <option v-for="n in store.sheetNames" :key="n" :value="n">{{ sheetLabel(n) }}</option>
          </select>
        </label>
      </div>
    </section>

    <section v-else class="wb-panel srr__fixed" data-act="ship-source">
      <div class="wb-panel__head"><span>运价来源</span></div>
      <div class="wb-panel__body">
        <dl class="srr__kv">
          <div class="srr__kv-row">
            <dt>源文件</dt>
            <dd :title="(store.source && store.source.filePath) || ''">{{ (store.source && store.source.fileName) || '—' }}</dd>
          </div>
          <div class="srr__kv-row">
            <dt>工作表</dt>
            <dd>{{ (store.source && store.source.sheetName) || (store.table && store.table.sheetName) || '—' }}</dd>
          </div>
          <div class="srr__kv-row">
            <dt>生效日</dt>
            <dd>{{ (store.source && store.source.effectiveFrom) || '—' }}</dd>
          </div>
          <div class="srr__kv-row" v-if="store.table">
            <dt>覆盖范围</dt>
            <dd>
              <b>{{ store.table.stats.countries }}</b> 个国家/地区 ·
              <b>{{ store.table.stats.cards }}</b> 张价卡（按KG {{ store.table.stats.perKgCards }} / 首重续重
              {{ store.table.stats.firstStepCards }}）· <b>{{ store.table.stats.sections }}</b> 个分节
            </dd>
          </div>
          <div class="srr__kv-row" v-if="store.table">
            <dt>报价币种</dt>
            <dd>{{ (store.table.stats.currencies || []).map(currencyText).join(' / ') || '未标注' }}</dd>
          </div>
        </dl>

        <p v-if="nonCny.length" class="wb-notice wb-notice--warn">
          这张工作表有 {{ nonCny.length }} 种非人民币报价（{{ nonCny.map(currencyText).join(' / ') }}）。本版没有汇率来源，这些线路在运费查询页会明确拒算而不是按人民币估算 ——
          按人民币直接算会差出数倍，且金额看起来完全正常。需要换算请切回人民币报价的线路。
        </p>

        <div class="srr__bar">
          <button class="wb-btn wb-btn--primary" type="button" data-act="ship-import" @click="importTable">
            导入 / 更新运价表
          </button>
          <label v-if="store.sheetNames.length > 1" class="wb-field">
            <span class="wb-field__label">切换工作表</span>
            <select
              class="wb-input"
              data-act="ship-sheet"
              :value="currentSheet"
              @change="onSheetChange(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="n in store.sheetNames" :key="n" :value="n">{{ sheetLabel(n) }}</option>
            </select>
          </label>
        </div>
        <p class="wb-muted srr__hint">
          这份文件里有 {{ store.sheetNames.length }} 张工作表，切换到别的线路是<b>整表替换</b>而非合并；Excel
          数值变更后重新导入即可覆盖（运价表存在宿主快照里、按生效日留档，源文件移动或删除都不影响已有报价，「统计」页也读同一份）。
        </p>
      </div>
    </section>

    <!-- ── 解析告警 ─────────────────────────────────────────────── -->
    <section v-if="store.hasTable && store.table && store.table.warnings.length" class="wb-panel srr__fixed" data-act="ship-warnings">
      <div class="wb-panel__head">
        <span>解析告警</span>
        <span class="wb-tag is-warn">{{ store.table.warnings.length }}</span>
      </div>
      <div class="wb-panel__body">
        <ul class="srr__warn-list">
          <li v-for="(x, i) in store.table.warnings.slice(0, 50)" :key="i">{{ x }}</li>
        </ul>
        <p v-if="store.table.warnings.length > 50" class="wb-muted">另有 {{ store.table.warnings.length - 50 }} 条未显示</p>
      </div>
    </section>

    <!-- ── 分节结构 ─────────────────────────────────────────────── -->
    <section v-if="store.hasTable && store.table" class="wb-panel srr__fixed" data-act="ship-sections">
      <div class="wb-panel__head">
        <span>分节结构</span>
        <span class="wb-muted">报价单把 {{ store.table.sections.length }} 段列结构不同的价卡拼在同一张 sheet 上，已逐段归一化</span>
      </div>
      <div class="wb-panel__body">
        <div class="wb-table-wrap">
          <table class="wb-table">
            <thead>
              <tr>
                <th class="wb-num">分节</th>
                <th class="wb-num">表头行</th>
                <th class="wb-num">国家数</th>
                <th>包含类别</th>
                <th>币种</th>
                <th class="wb-num">最低计费</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in store.table.sections" :key="s.sec">
                <td class="wb-num">{{ s.sec }}</td>
                <td class="wb-num wb-muted">{{ s.headerRow }}</td>
                <td class="wb-num">{{ s.countryCount }}</td>
                <td>{{ categoriesText(s.categories) }}</td>
                <td class="srq__nowrap">
                  {{ currencyText(s.currency)
                  }}<span v-if="s.currency && s.currency !== 'CNY'" class="wb-tag is-warn">未换算</span>
                </td>
                <td class="wb-num wb-muted">{{ s.minChargeG > 0 ? gramsText(s.minChargeG) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ── 国家运价 ─────────────────────────────────────────────── -->
    <section class="wb-panel">
      <div class="wb-panel__head">
        <span>国家运价</span>
        <input
          class="wb-input wb-input--sm"
          data-act="ship-country-filter"
          type="search"
          placeholder="筛选国家 / 英文名 / Code"
          :value="filter"
          @input="filter = ($event.target as HTMLInputElement).value"
        />
      </div>
      <div class="wb-panel__body srr__table-body">
        <div v-if="!store.hasTable" class="wb-empty srr__empty-sm">还没有运价表</div>
        <div v-else-if="!filteredCountries.length" class="wb-empty srr__empty-sm">没有匹配的国家</div>
        <div v-else class="wb-table-wrap">
          <table class="wb-table" data-act="ship-countries">
            <thead>
              <tr>
                <th class="srr__caret"></th>
                <th>国家/地区</th>
                <th>Code</th>
                <th class="wb-num">价卡数</th>
                <th colspan="3">主要档位</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="c in filteredCountries" :key="c.nameCn">
                <tr
                  class="srr__row-head"
                  :class="{ 'is-open': expanded.has(c.nameCn) }"
                  :data-act="`ship-country-${c.code || c.nameCn}`"
                  @click="toggle(c.nameCn)"
                >
                  <td class="srr__caret">{{ expanded.has(c.nameCn) ? '▾' : '▸' }}</td>
                  <td class="srq__nowrap">{{ c.nameCn }}</td>
                  <td class="wb-mono wb-muted srq__nowrap">{{ c.code || '—' }}</td>
                  <td class="wb-num">{{ c.cards.length }}</td>
                  <td colspan="3" class="wb-muted">
                    {{ c.cards.slice(0, 4).map((x) => rangeText(x.minG, x.maxG)).join('、')
                    }}{{ c.cards.length > 4 ? ` 等 ${c.cards.length} 档` : '' }}
                  </td>
                </tr>
                <template v-if="expanded.has(c.nameCn)">
                  <tr v-for="card in c.cards" :key="`${c.nameCn}-${card.sec}-${card.minG}-${card.mode}`" class="srr__sub">
                    <td></td>
                    <td colspan="2" class="srq__nowrap">
                      {{ categoriesText(card.categories)
                      }}<span v-if="card.variant" class="wb-tag">{{ card.variant }}</span
                      ><span v-if="card.currency && card.currency !== 'CNY'" class="wb-tag is-warn">{{
                        currencyText(card.currency)
                      }}</span>
                    </td>
                    <td class="wb-muted srq__nowrap">
                      {{ rangeText(card.minG, card.maxG)
                      }}<span v-if="card.minChargeG > 0" class="wb-tag">{{ gramsText(card.minChargeG) }} 起计</span>
                    </td>
                    <td class="wb-muted srq__nowrap">第 {{ card.sec }} 节</td>
                    <td class="wb-muted">{{ cardDetail(card) }}</td>
                    <td></td>
                  </tr>
                </template>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 高度链见 ShipRateQuoteTab.vue 的 style 头注：`flex:1` 只在祖先给出确定高度时
   才是"伸缩"，否则会把内容平分。本页尤其需要：国家运价表有 184 国 × 档位，
   不加约束会把上面几个信息面板一起推到视口外（2026-10-15 一起修）。 */
.srr {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
/* 上面几个是"看一眼就够"的固定信息块，不参与伸缩 */
.srr__fixed {
  flex-shrink: 0;
}
/* 国家运价表是唯一可伸缩区：自己滚动，不把整页撑高 */
.srr__table-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.srr__table-body > * {
  flex: 1 1 auto;
  min-height: 0;
}
.srr__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 12px;
  margin-top: 10px;
}
.srr__tried {
  margin-top: 10px;
  font-size: 12.5px;
}
.srr__manual {
  margin-top: 10px;
  max-width: 420px;
}
.srr__hint {
  margin-top: 10px;
  font-size: 12.5px;
  line-height: 1.6;
}
.srr__empty-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 6px;
}
.srr__empty-sm {
  padding: 18px 0;
  font-size: 12.5px;
}
.srr__kv {
  display: grid;
  grid-template-columns: minmax(72px, auto) 1fr;
  gap: 6px 14px;
  margin: 0;
  font-size: 13px;
}
.srr__kv-row {
  display: contents;
}
.srr__kv dt {
  color: var(--wb-text-muted);
}
.srr__kv dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.srr__warn-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.7;
}
.srr__caret {
  width: 28px;
  text-align: center;
  color: var(--wb-text-muted);
}
.srr__row-head {
  cursor: pointer;
}
.srr__row-head.is-open {
  background: var(--wb-surface-2, transparent);
}
.srr__sub td {
  color: var(--wb-text-muted);
  font-size: 12.5px;
}
</style>
