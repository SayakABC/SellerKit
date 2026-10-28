<template>
  <!-- 点遮罩不关：已经选好行/读完文件时误触等于白导一次 -->
  <div class="wb-mask">
    <div
      ref="dialogEl"
      class="wb-dialog wb-dialog--lg lg-imp"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      data-act="ledger-import"
      @dragover.prevent
      @drop.prevent="onDrop"
    >
      <div class="wb-dialog__head">
        <span>批量导入账目</span>
        <span v-if="fileName" class="wb-muted lg-imp__file" data-act="imp-filename">{{ fileName }}</span>
      </div>

      <div class="wb-dialog__body">
        <div class="lg-imp__bar">
          <button
            class="wb-btn wb-btn--sm wb-btn--primary"
            type="button"
            data-act="imp-pick"
            :disabled="busy || parsing"
            @click="pickFile"
          >
            {{ pickLabel }}
          </button>
          <button
            class="wb-btn wb-btn--sm"
            type="button"
            data-act="imp-template"
            :disabled="busy || writingTemplate"
            @click="downloadTemplate"
          >
            {{ writingTemplate ? '生成中…' : '下载模板' }}
          </button>
          <button
            v-if="problemRows.length"
            class="wb-btn wb-btn--sm"
            type="button"
            :class="{ 'is-on': showBadOnly }"
            :aria-pressed="showBadOnly"
            data-act="imp-only-problems"
            @click="showBadOnly = !showBadOnly"
          >
            只看要处理的（{{ problemRows.length }}）
          </button>
          <span v-if="parsing" class="wb-muted" data-act="imp-parsing">正在读这张表…</span>
          <span v-else-if="!fileName" class="wb-muted">也可以把 Excel 文件拖进这个弹层</span>
        </div>

        <p v-if="error" class="wb-notice wb-notice--error" data-act="imp-error">{{ error }}</p>

        <!-- 还没选文件：现状 + 为什么 + 下一步（文案纪律：空态必须给一个能点的动作） -->
        <div v-if="!fileName && !parsing" class="wb-empty" data-act="imp-idle">
          <div class="wb-empty__title">还没有文件</div>
          <p class="wb-empty__desc">
            一行一笔账。必须有这四样：发生日期、方向（收入 / 支出）、金额、相关人；
            一家店掏钱填「店铺」，几家店一起摊填「分摊店铺」。列名可以不一样，能认出来就行。
          </p>
          <p class="wb-empty__desc">
            相关人和科目：库里没有的会在导入时自动新建（新建的相关人类型是「其他」，导完可以到
            「记账 › 相关人」改）—— 所以名字打错一个字，就会多出一个「假房东」，之后的钱全累计到那个假名字上。
            预览里每一行都会标出「将新建」，请先扫一眼这些名字。
          </p>
          <p class="wb-empty__desc">
            店铺不一样：店是登记过的实体（平台、账号、企业一串信息），不会自动新建 ——
            名字对不上整行报错，请先到「基础数据 › 店铺」建好。对不上的行会整行标出来，不会悄悄跳过。
          </p>
          <div class="wb-empty__actions">
            <button class="wb-btn wb-btn--sm" type="button" data-act="imp-idle-template" @click="downloadTemplate">
              下载模板
            </button>
            <button
              class="wb-btn wb-btn--sm wb-btn--primary"
              type="button"
              data-act="imp-idle-pick"
              @click="pickFile"
            >
              选择 Excel 文件
            </button>
          </div>
        </div>

        <!-- 读了文件但没有一张表能当账目读：逐张说清"看过哪些表、为什么不行" -->
        <div v-else-if="!results.length && !parsing" class="lg-imp__reject" data-act="imp-rejected">
          <p class="wb-notice wb-notice--warn">
            {{ fileName }} 里没有一张表能当账目读 —— 缺「发生日期」「金额」「相关人」这几列。
            下一行是每张表的检查结果。
          </p>
          <ul v-if="scanned.length" class="lg-imp__scan" data-act="imp-scan">
            <li v-for="(s, i) in scanned" :key="i">{{ s }}</li>
          </ul>
          <div class="wb-empty__actions">
            <button class="wb-btn wb-btn--sm" type="button" data-act="imp-rejected-template" @click="downloadTemplate">
              下载模板（照它的列名填）
            </button>
            <button
              class="wb-btn wb-btn--sm wb-btn--primary"
              type="button"
              data-act="imp-rejected-pick"
              @click="pickFile"
            >
              换个文件
            </button>
          </div>
        </div>

        <template v-if="results.length && activeScan">
          <!-- ① 读的是哪张表、按哪些列读的（改了选表就重算，判据跟着变） -->
          <div class="lg-imp__sheet" data-act="imp-sheet">
            <span class="lg-imp__sheet-lead">读的是</span>
            <select
              v-if="qualifiedSheets.length > 1"
              v-model="sheetName"
              class="wb-input wb-input--sm lg-imp__sheet-select"
              data-act="imp-sheet-select"
              @change="reparse"
            >
              <option v-for="s in qualifiedSheets" :key="s.sheetName" :value="s.sheetName">
                {{ s.sheetName }}（{{ s.dataRows }} 行）
              </option>
            </select>
            <b v-else data-act="imp-sheet-name">{{ sheetName }}</b>
            <span v-if="qualifiedSheets.length > 1" class="wb-muted">
              这个文件里有 {{ qualifiedSheets.length }} 张表都能读，默认取行数最多的那张；不对就换一张。
            </span>
            <span class="wb-muted lg-imp__cols" data-act="imp-columns">
              按这些列读的：{{ matchedHeaders.join(' / ') || '（没有认出来的列）' }}
            </span>
          </div>

          <!-- ② 合计条：可导入笔数 + 勾上的钱 + 要处理的行数 -->
          <div class="lg-sum">
            <span data-act="imp-summary-pick">
              可导入 <b class="wb-mono">{{ picked.length }}</b> 笔 ·
              勾选部分 收入 <b class="wb-mono">{{ money(pickedIncomeCents) }}</b> /
              支出 <b class="wb-mono">{{ money(pickedExpenseCents) }}</b>
            </span>
            <span class="wb-muted" data-act="imp-summary-problem">
              <template v-if="badRows.length">{{ badRows.length }} 行不通过（不会导入）</template>
              <template v-else>没有不合格的行</template>
              <template v-if="newNameRows.length">
                · {{ newNameRows.length }} 行会新建名字（相关人 {{ newPartyNames.length }} 个 / 科目
                {{ newCategoryNames.length }} 个）
              </template>
              <template v-if="dupRows.length">
                · {{ dupRows.length }} 行像已经记过了（默认没勾）
                <button class="wb-link" type="button" data-act="imp-add-dups" @click="addDuplicates">
                  仍要重记这 {{ dupRows.length }} 行
                </button>
              </template>
              <template v-if="roundedRows.length">
                · {{ roundedRows.length }} 行金额超过两位小数、已自动保留两位
              </template>
              <template v-if="inferredBasisRows.length"> · {{ inferredBasisRows.length }} 行的分摊基准是推出来的</template>
            </span>
          </div>

          <p v-if="truncatedRows" class="wb-notice wb-notice--warn" data-act="imp-truncated">
            这张表还有 {{ truncatedRows }} 行没被读到（一次最多 {{ MAX_IMPORT_ROWS }} 行）：
            请先按月份或店铺筛一下再导 —— 静默少导几行是最难发现的那种错。
          </p>
          <p v-else-if="blankRows" class="wb-field__hint">
            表头下面另有 {{ blankRows }} 行整行是空的，已忽略。
          </p>

          <!-- ③ 逐行预览 -->
          <div class="wb-table-wrap lg-imp__table">
            <table class="wb-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      :checked="allPickableChecked"
                      :disabled="!pickableRowNos.length"
                      :title="
                        pickableRowNos.length
                          ? `勾选 / 取消全部能导入的行（${pickableRowNos.length} 行，不含疑似重复）`
                          : '没有能导入的行'
                      "
                      data-act="imp-check-all"
                      @change="toggleAllOk"
                    />
                  </th>
                  <th class="lg-imp__nowrap">行</th>
                  <th class="lg-imp__nowrap">发生日期</th>
                  <th>方向</th>
                  <th class="wb-num">金额</th>
                  <th>相关人</th>
                  <th>科目</th>
                  <th>归属</th>
                  <th>店铺 / 分摊</th>
                  <th>分摊基准</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="r in visibleRows" :key="r.rowNo">
                  <tr :data-act="`imp-row-${r.rowNo}`">
                    <td>
                      <input
                        type="checkbox"
                        :checked="isChecked(r)"
                        :disabled="!r.ok"
                        :title="r.ok ? '' : '这行有问题，改好文件再导（导入不会替你猜）'"
                        :data-act="`imp-check-${r.rowNo}`"
                        @change="toggleRow(r.rowNo)"
                      />
                    </td>
                    <td class="wb-mono lg-imp__nowrap">{{ r.rowNo }}</td>
                    <td class="wb-mono lg-imp__nowrap">{{ r.input.bizDate || '—' }}</td>
                    <td>{{ r.kindText || '—' }}</td>
                    <td class="wb-num">{{ r.amountCents ? money(r.amountCents) : '—' }}</td>
                    <td>{{ r.partyText || '—' }}</td>
                    <td>{{ r.categoryText || '—' }}</td>
                    <td>{{ r.scopeText || '—' }}</td>
                    <td>
                      <span>{{ r.input.scope === 'shared' ? allocShopLabel(r) : r.shopText || '—' }}</span>
                      <button
                        v-if="r.allocations.length > 1"
                        class="lg-link"
                        type="button"
                        :data-act="`imp-alloc-toggle-${r.rowNo}`"
                        @click="toggleAlloc(r.rowNo)"
                      >
                        {{ allocOpen.has(r.rowNo) ? '收起逐笔' : '看逐笔' }}
                      </button>
                    </td>
                    <td>
                      <span>{{ r.basisText || '—' }}</span>
                      <span v-if="r.basisInferred" class="wb-tag is-warn lg-imp__tag" title="文件里没写「分摊基准」：按分摊店铺里带的百分比判成手工比例，没带百分比按平均分摊">
                        推出来的
                      </span>
                    </td>
                    <td class="lg-imp__status">
                      <template v-if="!r.ok">
                        <span class="wb-tag is-warn" data-act="imp-row-bad">不通过</span>
                        <ul class="lg-imp__msgs">
                          <li v-for="(m, i) in r.errors" :key="`e${i}`" class="lg-imp__err">{{ m }}</li>
                        </ul>
                      </template>
                      <template v-else>
                        <span
                          v-if="r.newParty || r.newCategory"
                          class="wb-tag is-on lg-imp__tag"
                          data-act="imp-row-new"
                          :title="newNameTitle(r)"
                        >
                          将新建{{ r.newParty ? '相关人' : '' }}{{ r.newParty && r.newCategory ? ' + ' : '' }}{{ r.newCategory ? '科目' : '' }}
                        </span>
                        <span v-if="r.duplicate" class="wb-tag is-warn" data-act="imp-row-dup">像已记过</span>
                        <span
                          v-if="r.amountRounded"
                          class="wb-tag is-warn lg-imp__tag"
                          data-act="imp-row-rounded"
                          title="文件里的金额超过两位小数，导入只记到分：已按四舍五入记，下面写的是取了哪个数"
                        >
                          金额取整
                        </span>
                        <ul v-if="r.warnings.length" class="lg-imp__msgs">
                          <li v-for="(m, i) in r.warnings" :key="`w${i}`" class="lg-imp__warn">{{ m }}</li>
                        </ul>
                        <span v-if="!r.duplicate && !r.warnings.length && !r.newParty && !r.newCategory" class="wb-muted">
                          可以导入
                        </span>
                      </template>
                      <button
                        class="lg-link"
                        type="button"
                        :data-act="`imp-raw-toggle-${r.rowNo}`"
                        @click="toggleRaw(r.rowNo)"
                      >
                        {{ rawOpen.has(r.rowNo) ? '收起原文' : '看原文' }}
                      </button>
                    </td>
                  </tr>

                  <tr v-if="allocOpen.has(r.rowNo) || rawOpen.has(r.rowNo)" :data-act="`imp-extra-${r.rowNo}`">
                    <td colspan="11" class="lg-imp__extra">
                      <div v-if="allocOpen.has(r.rowNo)" class="lg-imp__allocs" data-act="imp-alloc-rows">
                        <span class="lg-imp__allocs-lead">这一笔摊给：</span>
                        <span v-for="a in r.allocations" :key="a.shopId" class="lg-imp__alloc">
                          {{ a.shopName }} <b class="wb-mono">{{ money(a.amountCents) }}</b>
                          <span class="wb-muted">{{ pctText(a.ratioBp) }}</span>
                        </span>
                        <span :class="{ 'lg-imp__gap': allocGap(r) !== 0 }" data-act="imp-alloc-sum">
                          逐笔合计 {{ money(allocTotal(r)) }}
                          <template v-if="allocGap(r) !== 0">—— 与金额差 {{ money(allocGap(r)) }}，这行不能导</template>
                        </span>
                      </div>
                      <div v-if="rawOpen.has(r.rowNo)" class="lg-imp__raw" data-act="imp-raw-cells">
                        <span v-for="c in LEDGER_IMPORT_COLUMNS" :key="c.key" class="lg-imp__rawcell">
                          <span class="wb-muted">{{ c.label }}</span>
                          <b>{{ r.cells[c.key] || '（空）' }}</b>
                        </span>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>

          <p v-if="hiddenRows" class="lg-imp__more">
            <button class="wb-btn wb-btn--sm" type="button" data-act="imp-show-more" @click="showMore">
              再显示 {{ Math.min(MORE_STEP, hiddenRows) }} 行（还有 {{ hiddenRows }} 行没显示）
            </button>
          </p>

          <p class="lg-imp__note" data-act="imp-note">
            导入只新增账目，不改动已有的；勾上的这批一起进，有一行没落库就整批退回（不会出现「导了一半」）。
            相关人 / 科目库里没有的会在同一批里新建，随这批一起成功或一起退回。
            结没结清不在这里填 —— 那要连带改往来余额与结算单，请在「往来」页签里做。
          </p>
        </template>
      </div>

      <div class="wb-dialog__foot">
        <button class="wb-btn" type="button" data-act="imp-cancel" :disabled="busy" @click="close">取消</button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="imp-submit"
          :disabled="!canSubmit"
          :title="submitHint"
          @click="submit"
        >
          {{ busy ? '导入中…' : `导入 ${picked.length} 笔` }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 「记账 › 批量导入」：一份 Excel → 逐行核对 → 整批新增。
//
// 本组件**只做取数与展示**，一个字段的判据都不在这里算：
//   · 认列 / 认单元格 / 摊钱 / 查重 —— 全在 `src/lib/ledgerImport.ts`（与单测同一份实现）；
//   · 名字是不是同一个对象、是不是同名多店 —— 全在宿主（`ledger-name-resolve` 的结论）；
//   · 分摊金额 —— `computeAllocations`（与「记一笔」同一个函数，RK-06）。
// 在这里再算一遍，就是"预览是一堆数、落库是另一堆数"的开端。
//
// 三条硬约束（方案 §5.5 / §7）：
//   ① 导入**只新增**，不更新已有条目（账目没有业务主键，同一笔房租可以记两遍 —— 猜哪条是"原来的"必然猜错）；
//      相关人 / 科目库里没有的会在同一批里新建（同一事务，失败一起退回），店铺不新建；
//   ② 整批一个事务：任一行没落库就整批退回，错误文案带「第 N 行」回到文件里的那一行；
//   ③ 不产生结算单：文件里填了「结算状态」也只当没填，逐行说明（半份文件冒充已结最伤台账）。
import { computed, ref } from 'vue';
import { selectExcelFile } from '@/core/services/dialog';
import { readWorkbookSheets, type ImportSource } from '@/core/services/importSheet';
import { LEDGER_IMPORT_MAX_ROWS } from '@/lib/ledgerImport';
import { formatCents, periodOf } from '@/lib/ledger';
import {
  LEDGER_IMPORT_COLUMNS,
  buildLedgerImportPayload,
  buildLedgerTemplateSheets,
  collectImportNameLookups,
  collectImportPeriodNeeds,
  ledgerEntryFingerprintsFromRows,
  parseLedgerImportRows,
  pickableImportRowNos,
  pickLedgerImportSheet,
  resolveLedgerImportRows,
  scanLedgerImportSheets,
  type LedgerImportCellRow,
  type LedgerImportContext,
  type LedgerImportHeaderScan,
  type LedgerImportRowResult,
  type LedgerImportSheet,
  type LedgerTemplateNames,
} from '@/lib/ledgerImport';
import { revenueFromOrderRows, type LedgerRevenue } from '@/lib/ledgerRevenue';
import { toast } from '@/core/services/toast';
import * as api from './api';
import { useDialogA11y } from './useDialogA11y';
import type { LedgerCategoryRow, LedgerPartyRow, ShopListItem } from '@/types';

const props = defineProps<{
  categories: LedgerCategoryRow[];
  parties: LedgerPartyRow[];
  shops: ShopListItem[];
}>();

const emit = defineEmits<{
  close: [];
  done: [
    result: {
      created: number;
      allocations: number;
      rows: number;
      incomeCents: number;
      expenseCents: number;
      sheetName: string;
      periods: string[];
      /** 本批自动新建的相关人 / 科目名字（主进程如实返回；界面要念出来） */
      createdParties: string[];
      createdCategories: string[];
      /** 本批写进去的条目 id（父层拿它做「撤销本次导入」；只在本次会话有效，不落库） */
      ids: number[];
    },
  ];
}>();

/** 一次导入最多跨几个月：营收占比与「当期营业中的店」都按月取，月份铺太开会把取数变成暗坑 */
const MAX_IMPORT_PERIODS = 24;
/** 与「记一笔」同一份取数上限：超过就视为截断，按半份订单算占比会把钱摊错 */
const ORDER_ROW_LIMIT = 2000;
/** 查重用的已有条目取数上限：超出 1000 行的那个月只做"部分查重"（漏报不误报） */
const DEDUP_ROW_LIMIT = 1000;
/** 预览一屏先渲这么多行（2000 行全渲进 DOM 会把弹层卡住） */
const VISIBLE_STEP = 200;
const MORE_STEP = 500;

const fileName = ref('');
const error = ref('');
const parsing = ref(false);
const busy = ref(false);
const writingTemplate = ref(false);
const dialogEl = ref<HTMLElement | null>(null);
useDialogA11y(dialogEl, close);

const rawSheets = ref<LedgerImportSheet[]>([]);
const sheetScans = ref<LedgerImportHeaderScan[]>([]);
const scanned = ref<string[]>([]);
const sheetName = ref('');

const results = ref<LedgerImportRowResult[]>([]);
const checked = ref(new Set<number>());
const allocOpen = ref(new Set<number>());
const rawOpen = ref(new Set<number>());
const blankRows = ref(0);
const truncatedRows = ref(0);
const visibleLimit = ref(VISIBLE_STEP);
const showBadOnly = ref(false);

const MAX_IMPORT_ROWS = LEDGER_IMPORT_MAX_ROWS;

/** 名字去重（空串略过；文件里同一个名字出现 20 行也只算新建 1 个） */
function distinctNames(list: readonly string[]): string[] {
  return [...new Set(list.filter((n) => !!n))];
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function money(cents: number): string {
  return cents < 0 ? `-¥${formatCents(-cents)}` : `¥${formatCents(cents)}`;
}

const pickLabel = computed(() => {
  if (parsing.value) return '读取中…';
  return fileName.value ? '换一个文件' : '选择 Excel 文件';
});

const activeScan = computed<LedgerImportHeaderScan | null>(
  () => sheetScans.value.find((s) => s.sheetName === sheetName.value) ?? null
);

const qualifiedSheets = computed(() => sheetScans.value.filter((s) => s.qualified));

/** 命中的列显示**文件里的表头原文**（不是本软件的列名）：用户要回表里核对的是他自己写的那一行 */
const matchedHeaders = computed<string[]>(() => {
  const scan = activeScan.value;
  if (!scan) return [];
  return LEDGER_IMPORT_COLUMNS.filter((c) => scan.columns[c.key] !== -1).map(
    (c) => String(scan.headers[scan.columns[c.key]] ?? c.label)
  );
});

const okRows = computed(() => results.value.filter((r) => r.ok));
const badRows = computed(() => results.value.filter((r) => !r.ok));
const dupRows = computed(() => results.value.filter((r) => r.duplicate));
const roundedRows = computed(() => results.value.filter((r) => r.amountRounded));
const inferredBasisRows = computed(() => results.value.filter((r) => r.basisInferred));
/** 会新建名字的行（这些名字值得人扫一眼 —— 打错一个字就是凭空多一个假对象） */
const newNameRows = computed(() => results.value.filter((r) => r.ok && (r.newParty || r.newCategory)));
const newPartyNames = computed(() => distinctNames(newNameRows.value.map((r) => r.newParty)));
const newCategoryNames = computed(() => distinctNames(newNameRows.value.map((r) => r.newCategory)));
const problemRows = computed(() =>
  results.value.filter(
    (r) => !r.ok || r.warnings.length > 0 || r.basisInferred || r.newParty || r.newCategory
  )
);

const filteredRows = computed(() =>
  showBadOnly.value ? problemRows.value : results.value
);
const visibleRows = computed(() => filteredRows.value.slice(0, visibleLimit.value));
const hiddenRows = computed(() => Math.max(0, filteredRows.value.length - visibleLimit.value));

/** 勾上的、且真的能导入的行（不合格的行勾不上，也不进这批） */
const picked = computed(() =>
  results.value.filter((r) => r.ok && r.selected && checked.value.has(r.rowNo))
);
const pickedIncomeCents = computed(() =>
  picked.value.filter((r) => r.input.kind === 'income').reduce((s, r) => s + r.amountCents, 0)
);
const pickedExpenseCents = computed(() =>
  picked.value.filter((r) => r.input.kind === 'expense').reduce((s, r) => s + r.amountCents, 0)
);

/** 全选只勾"合格且不像重复"的行；判据在 lib 里（`pickableImportRowNos`），界面不另算一套 */
const pickableRowNos = computed(() => pickableImportRowNos(results.value));

const allPickableChecked = computed(
  () => pickableRowNos.value.length > 0 && pickableRowNos.value.every((no) => checked.value.has(no))
);

const canSubmit = computed(
  () => !busy.value && !parsing.value && results.value.length > 0 && picked.value.length > 0
);

const submitHint = computed(() => {
  if (busy.value) return '正在导入…';
  if (parsing.value) return '先把文件读完';
  if (!results.value.length) return '先选择要导入的文件';
  if (!picked.value.length) return '一行都没勾 —— 勾上能导入的行，或改好文件再导';
  return `整批新增 ${picked.value.length} 笔（有任一行没落库就整批退回）`;
});

function isChecked(r: LedgerImportRowResult): boolean {
  return checked.value.has(r.rowNo);
}

function toggleRow(rowNo: number): void {
  const next = new Set(checked.value);
  if (next.has(rowNo)) next.delete(rowNo);
  else next.add(rowNo);
  checked.value = next;
}

function toggleAllOk(): void {
  const next = new Set(checked.value);
  const allOn = allPickableChecked.value;
  for (const no of pickableRowNos.value) {
    if (allOn) next.delete(no);
    else next.add(no);
  }
  checked.value = next;
}

/** 「确实要重记」的显式动作：把疑似重复也勾上（不藏在全选里，必须点这一下） */
function addDuplicates(): void {
  const next = new Set(checked.value);
  for (const r of dupRows.value) if (r.ok) next.add(r.rowNo);
  checked.value = next;
}

function toggleAlloc(rowNo: number): void {
  const next = new Set(allocOpen.value);
  if (next.has(rowNo)) next.delete(rowNo);
  else next.add(rowNo);
  allocOpen.value = next;
}

function toggleRaw(rowNo: number): void {
  const next = new Set(rawOpen.value);
  if (next.has(rowNo)) next.delete(rowNo);
  else next.add(rowNo);
  rawOpen.value = next;
}

function showMore(): void {
  visibleLimit.value += MORE_STEP;
}

function allocTotal(r: LedgerImportRowResult): number {
  return r.allocations.reduce((s, a) => s + a.amountCents, 0);
}

/** 逐笔与整笔的差额：解析层已经保证为 0，这里只是**显示时再核一次**（核不上就明说，不静默） */
function allocGap(r: LedgerImportRowResult): number {
  return r.amountCents - allocTotal(r);
}

function pctText(ratioBp: number): string {
  return `${(ratioBp / 100).toFixed(2)}%`;
}

/** 「将新建」标签的悬停说明：把要新建的名字原样写出来（标签位置放不下，但必须查得到） */
function newNameTitle(r: LedgerImportRowResult): string {
  const bits: string[] = [];
  if (r.newParty) bits.push(`相关人「${r.newParty}」`);
  if (r.newCategory) bits.push(`科目「${r.newCategory}」`);
  return `${bits.join('、')}库里没有，导入时会新建（新建的相关人类型是「其他」，之后可在「记账 › 相关人」改）`;
}

function allocShopLabel(r: LedgerImportRowResult): string {
  return `${r.allocations.length} 家`;
}

// ---------------------------------------------------------------------------
// 取数：文件 → 表 → 名字/期间 → 逐行结论
// ---------------------------------------------------------------------------

async function pickFile(): Promise<void> {
  if (busy.value) return;
  const sel = await selectExcelFile();
  if (!sel) return; // 用户在文件框点了取消：不是失败，不写错误
  await ingest({ filePath: sel.filePath, data: sel.data }, baseName(sel.filePath));
}

async function onDrop(e: DragEvent): Promise<void> {
  if (busy.value) return;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!/\.(xlsx|xls)$/i.test(file.name)) {
    error.value = `「${file.name}」不是 Excel 文件（只能读 .xlsx / .xls）`;
    return;
  }
  const buf = await file.arrayBuffer();
  await ingest({ data: buf }, file.name);
}

function baseName(p: string): string {
  const s = String(p ?? '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** 选来的 / 拖进来的两条路合到这一个入口：读表 → 挑表 → 逐行核对 */
async function ingest(src: ImportSource, shownName: string): Promise<void> {
  parsing.value = true;
  error.value = '';
  results.value = [];
  checked.value = new Set();
  allocOpen.value = new Set();
  rawOpen.value = new Set();
  try {
    const wb = await readWorkbookSheets(src);
    const sheets = (wb.grids ?? []).map((g) => ({ name: g.name, grid: g.grid }));
    rawSheets.value = sheets;
    sheetScans.value = scanLedgerImportSheets(sheets);
    const pickedSheet = pickLedgerImportSheet(sheets);
    scanned.value = pickedSheet.scanned;
    fileName.value = shownName;
    visibleLimit.value = VISIBLE_STEP;
    showBadOnly.value = false;
    if (!pickedSheet.picked) {
      sheetName.value = '';
      return;
    }
    sheetName.value = pickedSheet.picked.sheetName;
    await reparse();
  } catch (e: unknown) {
    error.value = `读不了这个文件：${msgOf(e)}`;
    rawSheets.value = [];
    sheetScans.value = [];
    scanned.value = [];
    sheetName.value = '';
    fileName.value = '';
    results.value = [];
  } finally {
    parsing.value = false;
  }
}

/** 换表 = 重新逐行核对（列位置、行号都跟着这张表走，不能沿用上一张的结论） */
async function reparse(): Promise<void> {
  const scan = activeScan.value;
  const sheet = rawSheets.value.find((s) => s.name === sheetName.value);
  if (!scan || !scan.qualified || !sheet) {
    results.value = [];
    checked.value = new Set();
    return;
  }
  parsing.value = true;
  error.value = '';
  try {
    const parsed = parseLedgerImportRows(sheet, scan);
    blankRows.value = parsed.blankRows;
    truncatedRows.value = parsed.truncated;
    // 列级问题（如表头缺「相关人」）在这里说一次 —— 逐行刷 800 条同样的红字，
    // 用户会以为要改 800 处，而真相是表头少了一列
    if (parsed.columnErrors.length) error.value = parsed.columnErrors.join('；');
    if (!parsed.rows.length) {
      results.value = [];
      checked.value = new Set();
      error.value = `「${sheet.name}」表头下面没有一行有内容：模板的数据表只有表头，要先把账目填进那一页再导`;
      return;
    }
    const ctx = await buildContext(parsed.rows);
    results.value = resolveLedgerImportRows(parsed.rows, ctx);
    // 默认勾选 = 合格且不像重复（`selected` 由解析层给判据，这里只照抄，不再自己判）
    checked.value = new Set(results.value.filter((r) => r.selected).map((r) => r.rowNo));
    allocOpen.value = new Set();
    rawOpen.value = new Set();
    visibleLimit.value = VISIBLE_STEP;
  } catch (e: unknown) {
    error.value = msgOf(e);
    results.value = [];
    checked.value = new Set();
  } finally {
    parsing.value = false;
  }
}

function distinctPeriods(rows: readonly LedgerImportCellRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    if (r.bizDate) set.add(periodOf(r.bizDate));
  }
  return [...set].sort();
}

/**
 * 逐行核对要问宿主的三件事：名字对不上的结论、当期能摊的店、营收权重，再加"库里是不是已有同样的账"。
 *
 * 取数**只按需要取**：文件里没有「全部」摊法就不问店铺，没有「按营收占比」就不拉订单；
 * 拉了也不用会静默降级成"每行报错"（解析层对拿不到的期间有明确文案，比这里猜一个口径可信）。
 */
async function buildContext(rows: readonly LedgerImportCellRow[]): Promise<LedgerImportContext> {
  const periods = distinctPeriods(rows);
  if (periods.length > MAX_IMPORT_PERIODS) {
    throw new Error(
      `这份文件跨了 ${periods.length} 个月，一次最多导 ${MAX_IMPORT_PERIODS} 个月：请按月份分成几份再逐份导入`
    );
  }
  const needs = collectImportPeriodNeeds(rows);
  const shopRefs = props.shops.map((s) => ({ id: s.id, name: s.name, nameKey: s.nameKey }));

  const [refs, eligibleList, revenueList, knownList] = await Promise.all([
    api.nameResolve(collectImportNameLookups(rows)),
    Promise.all(
      needs.eligiblePeriods.map(async (p) => ({
        period: p,
        ids: (await api.eligibleShops(p)).eligible.map((s) => s.id),
      }))
    ),
    Promise.all(
      needs.revenuePeriods.map(async (p) => {
        const orderRows = await api.monthOrderRows(p, ORDER_ROW_LIMIT);
        return {
          period: p,
          revenue: revenueFromOrderRows({ orders: orderRows, shops: shopRefs, limit: ORDER_ROW_LIMIT }),
        };
      })
    ),
    Promise.all(
      periods.map(async (p) =>
        ledgerEntryFingerprintsFromRows(
          // 公共条目的指纹要含分摊签名，必须让列表补上分摊行（否则房租/工资这类按月重复导入完全无保护）
          await api.entries({ period: p, limit: DEDUP_ROW_LIMIT, includeAllocations: true })
        )
      )
    ),
  ]);

  const eligibleByPeriod: Record<string, number[]> = {};
  for (const e of eligibleList) eligibleByPeriod[e.period] = e.ids;

  const byPeriod: Record<string, LedgerRevenue> = {};
  for (const r of revenueList) byPeriod[r.period] = r.revenue;

  const shopNameById: Record<number, string> = {};
  for (const s of props.shops) shopNameById[s.id] = s.name;

  return {
    refs,
    eligibleByPeriod,
    revenue: { byPeriod },
    shopNameById,
    knownFingerprints: knownList.flat(),
  };
}

// ---------------------------------------------------------------------------
// 模板 / 提交
// ---------------------------------------------------------------------------

/** 模板里的「已有名称」表 = 账本里现在能用的名字（导入不新建，用户最需要抄的就是这个） */
function templateNames(): LedgerTemplateNames {
  const alive = props.parties.filter((p) => !p.archived).map((p) => p.name);
  const cats = props.categories.filter((c) => !c.archived);
  return {
    parties: alive,
    expenseCategories: cats.filter((c) => c.kind === 'expense').map((c) => c.name),
    incomeCategories: cats.filter((c) => c.kind === 'income').map((c) => c.name),
    shops: props.shops.map((s) => s.name),
  };
}

async function downloadTemplate(): Promise<void> {
  if (writingTemplate.value || busy.value) return;
  writingTemplate.value = true;
  error.value = '';
  try {
    const res = await api.importTemplate({
      sheets: buildLedgerTemplateSheets(templateNames()),
      defaultName: '记账导入模板.xlsx',
    });
    if (!res) return; // 点了取消
    toast(`模板已存到 ${res.filePath}`, 'success');
  } catch (e: unknown) {
    error.value = `模板下载失败：${msgOf(e)}`;
  } finally {
    writingTemplate.value = false;
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  const rows = results.value.map((r) => ({ ...r, selected: isChecked(r) }));
  const picked = rows.filter((r) => r.selected && r.ok);
  const payload = buildLedgerImportPayload(picked);
  const incomeCents = pickedIncomeCents.value;
  const expenseCents = pickedExpenseCents.value;
  busy.value = true;
  error.value = '';
  try {
    const res = await api.batchCreate(payload);
    emit('done', {
      created: res.created,
      allocations: res.allocations,
      rows: payload.length,
      incomeCents,
      expenseCents,
      sheetName: sheetName.value,
      // 整份文件只写了一个月时，父层要跟着切过去，否则"导入成功"却看不到这些条目
      periods: [...new Set(picked.map((r) => r.period))].sort(),
      createdParties: res.createdParties ?? [],
      createdCategories: res.createdCategories ?? [],
      ids: res.ids ?? [],
    });
  } catch (e: unknown) {
    // 整批一个事务：失败就是"一笔都没进"，文案必须这么说，不能说"部分成功"
    error.value = `导入失败，一笔都没进：${msgOf(e)}。改好文件后再导一次`;
  } finally {
    busy.value = false;
  }
}

function close(): void {
  if (busy.value) return;
  emit('close');
}
</script>

<style scoped>
.lg-imp {
  width: min(1180px, 96vw);
}
.lg-imp__file {
  font-weight: 400;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lg-imp__bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 12.5px;
}
.lg-imp__reject {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lg-imp__scan {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--wb-text-muted);
}
.lg-imp__sheet {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 12.5px;
}
.lg-imp__sheet-lead {
  color: var(--wb-text-muted);
}
.lg-imp__sheet-select {
  width: auto;
  min-width: 160px;
}
.lg-imp__cols {
  flex-basis: 100%;
}
.lg-sum {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  margin-bottom: 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
  font-size: 12.5px;
}
.lg-imp__table {
  max-height: 46vh;
  overflow: auto;
}
.lg-imp__nowrap {
  white-space: nowrap;
}
.lg-imp__tag {
  margin-left: 4px;
}
.lg-imp__status {
  max-width: 320px;
}
.lg-imp__msgs {
  margin: 4px 0 0;
  padding-left: 16px;
  font-size: 12px;
  line-height: 1.5;
}
.lg-imp__err {
  color: var(--wb-danger);
}
.lg-imp__warn {
  color: var(--wb-warning);
}
.lg-imp__extra td {
  background: var(--wb-surface-2);
  font-size: 12px;
}
.lg-imp__allocs {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
}
.lg-imp__allocs-lead {
  color: var(--wb-text-muted);
}
.lg-imp__alloc {
  white-space: nowrap;
}
.lg-imp__gap {
  color: var(--wb-danger);
  font-weight: 600;
}
.lg-imp__raw {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--wb-border);
}
.lg-imp__rawcell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 90px;
}
.lg-imp__more {
  margin: 8px 0 0;
  text-align: center;
}
.lg-imp__note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--wb-text-muted);
}
.lg-link {
  padding: 0;
  margin-left: 6px;
  border: 0;
  background: none;
  color: var(--wb-primary);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
@media (max-width: 900px) {
  .lg-imp__table {
    max-height: 40vh;
  }
  .lg-imp__status {
    max-width: 240px;
  }
}
</style>
