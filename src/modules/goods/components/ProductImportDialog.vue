<template>
  <div class="wb-mask" @click.self="close">
    <div class="wb-dialog wb-dialog--lg" role="dialog" aria-modal="true" aria-label="导入产品">
      <div class="wb-dialog__head">
        <span>导入产品</span>
        <span v-if="fileName" class="im-file" :title="filePath">{{ fileName }}</span>
        <button class="im-x" type="button" aria-label="关闭" @click="close">✕</button>
      </div>

      <!-- 步骤条：三步向导必须让用户知道「现在第几步、还差几步」。
           岛时代只有标题在变，用户不知道后面还有没有别的动作要确认。 -->
      <ol class="im-steps">
        <li
          v-for="(s, i) in STEPS"
          :key="s.id"
          class="im-step"
          :class="{ 'is-done': stepIndex > i, 'is-active': stepIndex === i }"
        >
          <span class="im-step__no">{{ stepIndex > i ? '✓' : i + 1 }}</span>
          {{ s.label }}
        </li>
      </ol>

      <!-- ── ① 选文件 ────────────────────────────────────────────── -->
      <div v-if="step === 'pick'" class="wb-dialog__body im-body">
        <p class="im-lead">
          支持 Excel（.xlsx / .xls）。表头需含<b>款编码</b>与<b>款式名</b>两列，其余列可缺省；<br />
          列名同义写法都会自动识别（如 产品编码 / 商品名称 / 供应商 / 品类）。表头不在第一行也能找到。
        </p>
        <ul class="im-tips">
          <li>
            供应商列填<b>「供应商」页签里的名称</b>即为关联；填了但对不上会按「未关联」导入并提示，不会去猜。
          </li>
          <li>状态列可填 启用 / 停用 / active / archived，留空按「启用」。</li>
          <li>整批在<b>一个事务</b>里落库；个别行不合格不影响其余行入库。</li>
        </ul>
        <p class="im-lead im-lead--last">
          没有现成表格？<button class="wb-link" type="button" @click="$emit('template')">
            下载导入模板
          </button>
        </p>
        <p v-if="error" class="wb-notice wb-notice--error">{{ error }}</p>
      </div>

      <!-- ── ② 预览 + 修错 ───────────────────────────────────────── -->
      <template v-else-if="step === 'preview'">
        <div class="im-summary">
          <span>共 <b>{{ rows.length }}</b> 行</span>
          <span class="is-ok">可导入 <b>{{ importable.length }}</b></span>
          <span v-if="errorRows.length" class="is-err">
            有问题 <b>{{ errorRows.length }}</b>
          </span>
          <span v-if="warnCount" class="is-warn">提示 <b>{{ warnCount }}</b></span>
          <span class="im-origin">
            来自「{{ origin?.pickedSheet || '—' }}」第 {{ origin?.headerRow || '—' }} 行表头<template
              v-if="origin?.blankRows"
            >
              （跳过 {{ origin.blankRows }} 个空行）</template
            ><template v-if="origin?.headers?.length">
              ，识别到：{{ (origin.headers || []).filter(Boolean).join(' / ') }}
            </template>
          </span>
        </div>

        <div class="im-bar">
          <span class="im-bar__label">已存在的编码</span>
          <button
            type="button"
            class="wb-btn wb-btn--sm"
            data-act="mode-upsert"
            :class="{ 'is-on': mode === 'upsert' }"
            :aria-pressed="mode === 'upsert'"
            @click="mode = 'upsert'"
          >
            覆盖更新
          </button>
          <button
            type="button"
            class="wb-btn wb-btn--sm"
            data-act="mode-insert-only"
            :class="{ 'is-on': mode === 'insertOnly' }"
            :aria-pressed="mode === 'insertOnly'"
            @click="mode = 'insertOnly'"
          >
            跳过不覆盖
          </button>

          <span class="im-bar__spacer"></span>

          <!-- 默认「只看有问题」：500 行里 495 行是好的，全列出来等于把问题埋掉。
               但用户也可能想通读一遍，所以给得到开关，且**明确报出被折叠了多少行**。 -->
          <button
            type="button"
            class="wb-btn wb-btn--sm"
            data-act="only-problems"
            :class="{ 'is-on': onlyProblems }"
            :aria-pressed="onlyProblems"
            :disabled="!problemRows.length"
            @click="onlyProblems = !onlyProblems"
          >
            只看有问题<span v-if="problemRows.length">（{{ problemRows.length }}）</span>
          </button>
        </div>

        <p v-if="errorRows.length" class="wb-notice wb-notice--warn im-note">
          标红的 <b>{{ errorRows.length }}</b> 行不会被导入。可直接在表格里改「款编码 / 款式名」，
          改好会立刻变回待导入；也可以先导入其余行，之后再补。
        </p>

        <div class="im-tablewrap">
          <table class="wb-table im-table">
            <thead>
              <tr>
                <th class="im-c-no">行</th>
                <th class="im-c-st">状态</th>
                <th>款编码</th>
                <th>款式名</th>
                <th>供应商</th>
                <th>类目</th>
                <th>状态</th>
                <th class="im-c-msg">说明</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in visibleRows"
                :key="r.rowNo"
                :class="{ 'im-row--bad': !rowOk(r) }"
                :data-row-no="r.rowNo"
              >
                <td class="wb-muted">{{ r.rowNo }}</td>
                <td>
                  <span class="wb-tag" :class="rowOk(r) ? 'is-on' : 'im-tag--bad'">
                    {{ rowOk(r) ? '待导入' : '跳过' }}
                  </span>
                </td>
                <td>
                  <input
                    v-model="r.code"
                    class="wb-input wb-input--sm im-cell"
                    placeholder="必填"
                    :aria-label="`第 ${r.rowNo} 行款编码`"
                  />
                </td>
                <td><input v-model="r.name" class="wb-input wb-input--sm im-cell" :aria-label="`第 ${r.rowNo} 行款式名`" /></td>
                <td :class="{ 'wb-muted': !r.supplierId }">
                  {{ r.supplierId ? supplierName(r.supplierId) : r.supplierRaw || '未关联' }}
                </td>
                <td>{{ r.category || '—' }}</td>
                <td>{{ r.status === 'archived' ? '停用' : '启用' }}</td>
                <td class="im-msg">{{ issueOf(r.rowNo) }}</td>
              </tr>
              <tr v-if="!visibleRows.length">
                <td colspan="8" class="wb-muted im-none">没有可显示的行</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p v-if="onlyProblems && hiddenCount > 0" class="im-folded wb-muted">
          已折叠 {{ hiddenCount }} 行完全正常的行（关掉「只看有问题」可查看全部）。
        </p>
        <p v-if="error" class="wb-notice wb-notice--error im-note">{{ error }}</p>
      </template>

      <!-- ── ③ 结果 ─────────────────────────────────────────────── -->
      <div v-else class="wb-dialog__body im-body">
        <p class="im-result">
          新增 <b class="is-ok">{{ result.created }}</b> 条，更新
          <b class="is-ok">{{ result.updated }}</b> 条<template v-if="result.failed.length">
            ，因编码冲突跳过 <b class="is-err">{{ result.failed.length }}</b> 条</template
          >。
        </p>
        <p v-if="remaining.length" class="wb-notice wb-notice--warn">
          还有 <b>{{ remaining.length }}</b> 行没进来（{{ remainingReasons }}）。
          点「返回修改」可以改完再导一次。
        </p>
        <p v-else class="wb-notice wb-notice--ok">全部处理完毕。</p>
        <ul v-if="result.failed.length" class="im-failed">
          <li v-for="f in result.failed" :key="f.rowNo">
            第 {{ f.rowNo }} 行 <span class="wb-mono">{{ f.code }}</span> —— {{ f.message }}
          </li>
        </ul>
      </div>

      <div class="wb-dialog__foot">
        <template v-if="step === 'pick'">
          <button class="wb-btn" type="button" @click="close">取消</button>
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            data-act="pick-file"
            :disabled="busy"
            @click="pickFile"
          >
            {{ busy ? '读取中…' : '选择 Excel 文件' }}
          </button>
        </template>
        <template v-else-if="step === 'preview'">
          <button class="wb-btn" type="button" :disabled="busy" @click="backToPick">
            重新选择文件
          </button>
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            data-act="commit-import"
            :disabled="busy || !importable.length"
            @click="commit"
          >
            {{ busy ? '导入中…' : `导入 ${importable.length} 行` }}
          </button>
        </template>
        <template v-else>
          <button v-if="remaining.length" class="wb-btn" type="button" :disabled="busy" @click="backToPreview">
            返回修改
          </button>
          <button class="wb-btn wb-btn--primary" type="button" @click="finish">完成</button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 「导入产品」三步向导：选文件 → 预览修错 → 结果。
//
// 从 UI 岛搬迁时做了三处交互改动（都不是换皮）：
//   ① **加步骤条**：原实现只有标题在变，用户点了「选择文件」之后不知道后面还有几步要确认。
//   ② **默认只列有问题的行**：导入一次几百行，其中绝大多数是好的；全列出来等于把
//      "要改哪一行"埋进长列表里。关掉开关仍可通读，且折叠行数会明确报出（不许静默省略）。
//   ③ **行内编辑即时回判**：改「款编码 / 款式名」后本地立刻重算合格性 —— 用户不必
//      等提交才知道改对了没有。本地判定**只用于即时反馈**，放行仍以库层校验为准。
//
// 判定分两层且顺序不能反：
//   · 本地可判定的（编码非空、同批不重复）在这里算；
//   · 其余（超长、供应商对不上、编码已存在）以宿主 / 库层为准，结果回到「说明」列。
import { computed, reactive, ref } from 'vue';
import { previewProductImport, commitProductImport, pickExcel } from '../productIo';
import type { ProductImportOrigin } from '../productIo';
import type { ProductImportIssue, ProductImportRowResult } from '@/lib/productImport';
import * as api from '../api';
import { toast } from '@/core/services/toast';

const emit = defineEmits<{ close: []; done: []; template: [] }>();

const STEPS = [
  { id: 'pick' as const, label: '选文件' },
  { id: 'preview' as const, label: '核对' },
  { id: 'done' as const, label: '完成' },
];

const step = ref<'pick' | 'preview' | 'done'>('pick');
const stepIndex = computed(() => STEPS.findIndex((s) => s.id === step.value));

const busy = ref(false);
const error = ref('');
const filePath = ref('');
const fileName = ref('');
const origin = ref<ProductImportOrigin | null>(null);

/** 宿主返回的原始 issues（按 rowNo 索引出「说明」列） */
const issues = ref<ProductImportIssue[]>([]);
const rows = ref<ProductImportRowResult[]>([]);
const mode = ref<'upsert' | 'insertOnly'>('upsert');
const onlyProblems = ref(false);
const result = reactive<{ created: number; updated: number; failed: { rowNo: number; code: string; message: string }[] }>({
  created: 0,
  updated: 0,
  failed: [],
});

const suppliers = ref(new Map<number, string>());

/** 同一编码出现两次时，后出现的那行会被库层拦下 —— 本地先标出来，用户不必等提交才知道 */
const dupCodes = computed(() => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const r of rows.value) {
    const c = String(r.code || '').trim();
    if (!c) continue;
    if (seen.has(c)) dup.add(c);
    else seen.add(c);
  }
  return dup;
});

/** 本地可判定的合格性：编码非空且不重复。其余（超长、供应商对不上）以库层校验为准 */
function rowOk(r: ProductImportRowResult): boolean {
  const c = String(r.code || '').trim();
  return !!c && !dupCodes.value.has(c);
}

const importable = computed(() => rows.value.filter(rowOk));
const errorRows = computed(() => rows.value.filter((r) => !rowOk(r)));
const warnCount = computed(() => issues.value.filter((x) => x.level === 'warning').length);

/** 有问题的行 = 本地判不合格 **或** 宿主给了 error 级 issue */
const problemRows = computed(() => rows.value.filter((r) => !rowOk(r) || issueOf(r.rowNo) !== ''));
const visibleRows = computed(() => (onlyProblems.value ? problemRows.value : rows.value));
const hiddenCount = computed(() => rows.value.length - visibleRows.value.length);

function issueOf(rowNo: number): string {
  return issues.value
    .filter((x) => x.rowNo === rowNo && x.level === 'error')
    .map((x) => x.message)
    .join('；');
}

function supplierName(id: number): string {
  return suppliers.value.get(Number(id)) || `#${id}`;
}

/** 读文件后的公共收尾：供应商名映射 → 决定预览默认视图 */
async function afterPreview(): Promise<void> {
  try {
    const s = await api.summary();
    suppliers.value = new Map((s?.supplierOptions ?? []).map((x) => [x.id, x.name]));
  } catch {
    // 供应商下拉名拿不到不该挡住导入：只是「说明」列少一层可读性
    suppliers.value = new Map();
  }
  // 有问题才默认只列问题行；全好时默认通读（此时开关是禁用的）
  onlyProblems.value = problemRows.value.length > 0;
}

async function pickFile(): Promise<void> {
  error.value = '';
  let file: Awaited<ReturnType<typeof pickExcel>> = null;
  try {
    file = await pickExcel();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  if (!file) return; // 用户取消

  filePath.value = file.filePath;
  fileName.value = String(file.filePath).split(/[\\/]/).pop() || '';
  busy.value = true;
  try {
    const preview = await previewProductImport(file);
    rows.value = preview.rows.map((x) => ({ ...x }));
    issues.value = preview.issues;
    origin.value = preview.origin;
    await afterPreview();
    step.value = 'preview';
    if (!rows.value.length) error.value = '这份文件里没有读到任何产品行。';
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function commit(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    // 整批回传（含不合格行）：`commitProductImport` 会用同一套纯函数**再校验一遍**并只落合格行。
    // 界面上的判定只用于即时反馈，**不是**放行依据。
    const r = await commitProductImport(rows.value, mode.value);
    rows.value = r.rows.map((x) => ({ ...x }));
    issues.value = r.issues;
    result.created = r.created;
    result.updated = r.updated;
    result.failed = r.failed;
    onlyProblems.value = false;
    step.value = 'done';
    if (r.created + r.updated > 0) {
      toast(`导入完成：新增 ${r.created}，更新 ${r.updated}`, 'success');
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/** 提交后仍未进来的行（本地不合格 + 库层冲突） */
const remaining = computed(() => {
  const failedRows = new Set(result.failed.map((f) => f.rowNo));
  return rows.value.filter((r) => !rowOk(r) || failedRows.has(r.rowNo));
});

const remainingReasons = computed(() => {
  const parts: string[] = [];
  if (errorRows.value.length) parts.push(`${errorRows.value.length} 行编码有空缺或重复`);
  if (result.failed.length) parts.push(`${result.failed.length} 行编码已存在且选择了「跳过不覆盖」`);
  return parts.join('，') || '原因见预览';
});

function backToPick(): void {
  step.value = 'pick';
}

function backToPreview(): void {
  result.created = 0;
  result.updated = 0;
  result.failed = [];
  onlyProblems.value = problemRows.value.length > 0;
  step.value = 'preview';
}

function finish(): void {
  emit('done');
}

function close(): void {
  emit('close');
}
</script>

<style scoped>
.im-file {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 400;
  color: var(--wb-text-muted);
}
.im-x {
  flex-shrink: 0;
  margin-left: auto;
  padding: 2px 6px;
  border: 0;
  border-radius: var(--wb-radius-sm);
  background: transparent;
  font-size: 13px;
  color: var(--wb-text-muted);
  cursor: pointer;
}
.im-x:hover {
  background: var(--wb-hover);
  color: var(--wb-text);
}

/* ── 步骤条 ── */
.im-steps {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-shrink: 0;
  margin: 0;
  padding: 9px 16px;
  list-style: none;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-surface-2);
  font-size: 12px;
  color: var(--wb-text-muted);
}
.im-step {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.im-step__no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid var(--wb-border-strong);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.im-step.is-active {
  color: var(--wb-text);
  font-weight: 600;
}
.im-step.is-active .im-step__no {
  border-color: var(--wb-primary);
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
}
.im-step.is-done .im-step__no {
  border-color: var(--wb-success);
  background: var(--wb-success);
  color: var(--wb-primary-contrast);
}

.im-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.im-lead {
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
}
.im-lead--last {
  margin-top: 2px;
  color: var(--wb-text-muted);
}
.im-tips {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  color: var(--wb-text-muted);
  line-height: 1.9;
}

.im-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
  padding: 10px 16px;
  border-bottom: 1px solid var(--wb-border);
  font-size: 13px;
}
.im-summary b {
  font-weight: 600;
}
.im-origin {
  flex: 1 1 100%;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}
.is-ok {
  color: var(--wb-success);
}
.is-err {
  color: var(--wb-danger);
}
.is-warn {
  color: var(--wb-warning);
}

.im-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 16px;
  border-bottom: 1px solid var(--wb-border);
  font-size: 13px;
}
.im-bar__label {
  color: var(--wb-text-muted);
}
.im-bar__spacer {
  margin-left: auto;
}

.im-note {
  margin: 10px 16px 0;
}
.im-tablewrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.im-table th {
  z-index: 2;
}
.im-cell {
  width: 100%;
  min-width: 130px;
}
.im-c-no {
  width: 46px;
}
.im-c-st {
  width: 74px;
}
.im-c-msg {
  min-width: 210px;
}
.im-msg {
  color: var(--wb-danger);
  max-width: 320px;
  white-space: normal;
  font-size: 12px;
}
.im-none {
  padding: 28px 0;
  text-align: center;
}
.im-tag--bad {
  background: var(--wb-danger-soft);
  color: var(--wb-danger);
}
.im-row--bad :deep(td) {
  background: var(--wb-danger-soft);
}
.im-folded {
  flex-shrink: 0;
  margin: 0;
  padding: 8px 16px;
  border-top: 1px solid var(--wb-border);
  font-size: 12px;
}

.im-result {
  margin: 0;
  font-size: 14px;
}
.im-failed {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--wb-text-muted);
}
</style>
