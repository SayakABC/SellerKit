<template>
  <div class="wb-mask" @click.self="close">
    <div class="wb-dialog wb-dialog--lg" role="dialog" aria-modal="true" aria-label="导入产品">
      <div class="wb-dialog__head">
        <span>导入产品</span>
        <span v-if="fileName" class="im-file" :title="filePath">{{ fileName }}</span>
        <button class="im-x" type="button" aria-label="关闭" data-act="import-close" @click="close">✕</button>
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
          列名同义写法都会自动识别（如 产品编码 / 商品名称 / 供应商 / 主图）。表头不在第一行也能找到。
        </p>
        <ul class="im-tips">
          <li>
            <b>一行一个款</b>：<b>颜色</b>一格填一个；<b>尺码</b>可以填多格（逗号隔开，如
            <span class="wb-mono">M,L,XL</span>），<b>克重</b>按同样顺序一一对应（
            <span class="wb-mono">120,130,140</span>）；两列个数不一样会标红，不会去猜。
          </li>
          <li>
            <b>图片</b>：把图<b>插入</b>到「图片」那一格里（在 Excel 里就是"在单元格里插图片"）。
            那一格里写的文字地址会被忽略 —— 图按它所在的行归位。
          </li>
          <li>
            供应商列填一个名称即可：库里已有同名供应商就直接关联；<b>没有就自动新建一家</b>（预览里会标「新建」）。
          </li>
          <li>
            <b>款式名</b>在库里已存在时，那一行会标「同名」并<b>回填库里那条的款编码</b> ——
            默认<b>覆盖更新</b>那一款；不想动它，就把预览顶部的「同名款」开关设成 <b>跳过不覆盖</b>。
          </li>
          <li>
            <b>进价</b>（元）：填了会写成该款的成本（<b>从导入当天起生效</b>）—— 改价只影响之后的订单，
            历史订单仍按各自下单时的旧价算。<b>留空 = 不动库里已有的价</b>；填 <span class="wb-mono">0</span>
            表示零成本（赠品），与留空是两回事。
          </li>
          <li>状态列可填 启用 / 停用 / active / archived，留空按「启用」。</li>
          <li>
            这份模板<b>没有「类目」列</b>：导入不会改动库里已有的类目（老文件里的「类目」列也会被忽略）。
          </li>
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
          <span v-if="dupNameRows.length" class="is-warn" data-act="dup-name-count">
            同名款 <b>{{ dupNameRows.length }}</b>
          </span>
          <span v-if="imagesFound" class="im-imgs" data-act="import-images">
            图片 <b>{{ imagesLocated }}</b>/{{ imagesFound }} 张归位
          </span>
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

        <!-- 归不了位的图必须说出来：「导入成功但图一张没进来」不报的话，用户只会怀疑自己的 Excel -->
        <ul v-if="looseNotes.length" class="im-loose" data-act="import-notes">
          <li v-for="(x, i) in looseNotes" :key="i">{{ x.message }}</li>
        </ul>

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

          <!-- 同名款（款式名在库里已存在）：**单列一组**，因为它的判据是款式名、上面那组是编码。
               两件事的答案经常不一样（编码是新的、名字却已经有了），合成一个开关就会互相顶掉。 -->
          <span class="im-bar__label" data-act="same-name-label">
            同名款<span v-if="dupNameRows.length">（{{ dupNameRows.length }}）</span>
          </span>
          <button
            type="button"
            class="wb-btn wb-btn--sm"
            data-act="same-name-overwrite"
            :class="{ 'is-on': sameName === 'overwrite' }"
            :aria-pressed="sameName === 'overwrite'"
            :disabled="!dupNameRows.length"
            @click="sameName = 'overwrite'"
          >
            覆盖更新
          </button>
          <button
            type="button"
            class="wb-btn wb-btn--sm"
            data-act="same-name-skip"
            :class="{ 'is-on': sameName === 'skip' }"
            :aria-pressed="sameName === 'skip'"
            :disabled="!dupNameRows.length"
            @click="sameName = 'skip'"
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
          <table class="wb-table im-table" data-act="import-table">
            <thead>
              <tr>
                <th class="im-c-no">行</th>
                <th class="im-c-st">状态</th>
                <th>款编码</th>
                <th>款式名</th>
                <th>供应商</th>
                <th class="wb-num">进价</th>
                <th class="im-c-img">图片</th>
                <th>颜色</th>
                <th>尺码</th>
                <th>克重</th>
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
                  <!-- 同名款逐行标出：说明列只在"有问题"时才被读到，而这一条是**每一行都要看见**的
                       （用户要据此决定是覆盖还是跳过）。codeFromName 那一路的编码就是库里那条的，见右格。 -->
                  <span
                    v-if="r.nameMatched"
                    class="im-auto-tag im-auto-tag--name im-name-tag"
                    data-act="row-name-matched"
                    title="款式名在库里已存在；默认覆盖更新那一款（可用上方「同名款」开关改成跳过）"
                  >同名</span>
                </td>
                <td>
                  <div class="im-code-cell">
                    <input
                      v-model="r.code"
                      class="wb-input wb-input--sm im-cell"
                      placeholder="必填"
                      :aria-label="`第 ${r.rowNo} 行款编码`"
                      @input="clearCodeAutoGenerated(r)"
                    />
                    <span v-if="r.codeAutoGenerated" class="im-auto-tag">自动</span>
                  </div>
                </td>
                <td><input v-model="r.name" class="wb-input wb-input--sm im-cell" :aria-label="`第 ${r.rowNo} 行款式名`" /></td>
                <td :class="{ 'wb-muted': !r.supplierId && !r.supplierRaw }" data-act="row-supplier">
                  <template v-if="r.supplierId">{{ supplierName(r.supplierId) }}</template>
                  <template v-else-if="r.supplierRaw">
                    {{ r.supplierRaw }}<span v-if="r.supplierWillCreate" class="im-auto-tag im-auto-tag--new" data-act="row-supplier-new">新建</span>
                  </template>
                  <template v-else>未关联</template>
                </td>
                <td class="wb-num" data-act="row-cost">{{ costText(r) }}</td>
                <td
                  class="im-c-img"
                  data-act="row-image"
                  :data-has-image="r.imageId ? '1' : '0'"
                  :title="r.imageId ? '这一行插了图片，导入后会成为该款主图' : '这一行没有图'"
                >
                  <span v-if="r.imageId" class="wb-tag is-on">有图</span>
                  <span v-else class="wb-muted">—</span>
                </td>
                <td>{{ colorsOf(r) || '—' }}</td>
                <td>{{ skuCell(r, 'size') || '—' }}</td>
                <td>{{ skuCell(r, 'weight') || '—' }}</td>
                <td>{{ r.status === 'archived' ? '停用' : '启用' }}</td>
                <td class="im-msg">{{ issueOf(r.rowNo) }}</td>
              </tr>
              <tr v-if="!visibleRows.length">
                <td colspan="12" class="wb-muted im-none">没有可显示的行</td>
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
          <b class="is-ok">{{ result.updated }}</b> 条<template v-if="result.skusWritten">
            ，写入 SKU <b class="is-ok">{{ result.skusWritten }}</b> 个</template
          ><template v-if="result.imagesAttached">
            ，设为款主图 <b class="is-ok">{{ result.imagesAttached }}</b> 张</template
          ><template v-if="result.costsWritten">
            ，写入进价 <b class="is-ok">{{ result.costsWritten }}</b> 条</template
          ><template v-if="result.suppliersCreated">
            ，新建供应商 <b class="is-ok">{{ result.suppliersCreated }}</b> 家</template
          ><template v-if="result.skippedByName.length">
            ，按「同名款：跳过」留下 <b class="is-warn">{{ result.skippedByName.length }}</b> 条</template
          ><template v-if="result.failed.length">
            ，因编码冲突跳过 <b class="is-err">{{ result.failed.length }}</b> 条</template
          >。
        </p>
        <p v-if="remaining.length" class="wb-notice wb-notice--warn">
          还有 <b>{{ remaining.length }}</b> 行没进来（{{ remainingReasons }}）。
          点「返回修改」可以改完再导一次。
        </p>
        <p v-else class="wb-notice wb-notice--ok">全部处理完毕。</p>
        
        <!-- 成功导入的款编码明细 -->
        <div v-if="successCodes.length" class="im-success-list">
          <p class="im-success-title">成功导入的款编码：</p>
          <ul class="im-success-codes">
            <li v-for="(item, idx) in successCodes" :key="idx">
              <span class="wb-mono">{{ item.code }}</span>
              <span v-if="item.name" class="wb-muted"> — {{ item.name }}</span>
              <span v-if="item.autoGenerated" class="im-auto-tag-sm">自动</span>
              <span v-if="item.fromName" class="im-auto-tag-sm im-auto-tag--name">同名更新</span>
            </li>
          </ul>
        </div>
        
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
            :disabled="busy || !willSubmit.length"
            @click="commit"
          >
            {{ busy ? '导入中…' : `导入 ${willSubmit.length} 行` }}
          </button>
        </template>
        <template v-else>
          <button v-if="remaining.length" class="wb-btn" type="button" :disabled="busy" @click="backToPreview">
            返回修改
          </button>
          <button class="wb-btn wb-btn--primary" type="button" data-act="import-done" @click="finish">完成</button>
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
//   · 本地可判定的（编码非空、SKU 单元格没报错）在这里算；
//   · 其余（超长、供应商对不上、编码已存在）以宿主 / 库层为准，结果回到「说明」列。
//
// ---- 2026-10-08 随模板改列一起动过的三处 ----
//   ① 「类目」列没了（模板与导出都不再带它，导入也不覆盖库里已有的类目）；
//      换成「图片 / 颜色 / 尺码 / 克重」四列 —— 用户最关心的"图进来了没有"就在表上。
//   ② 本地"重复编码算错"的判定**删掉**了：同编码的行现在会**合并**成一个款
//      （见 `validateImportRows`），继续标红会把导出文件自己判成错的。
//   ③ 新增「图片归位 N/M」与文件级提示：抽图失败、图落在表头/空行上，都要看得见。
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
/**
 * 「同名款」（款式名在库内已存在）的处理方式。
 *
 * 与 `mode`（按**编码**已存在与否）分开：编码是新的、名字却已经有了，是最常见的一种情况
 * （用户改过名字或换了编码规则），这时两个判据给出相反的答案 —— 合成一个开关必然有一个被吞。
 * 默认**覆盖更新**：同名款的语义本身就是"这就是那个款"（编码已回填成库里那条的）。
 */
const sameName = ref<'overwrite' | 'skip'>('overwrite');
const onlyProblems = ref(false);
const imagesFound = ref(0);
const imagesLocated = ref(0);
const result = reactive<{
  created: number;
  updated: number;
  skusWritten: number;
  imagesAttached: number;
  costsWritten: number;
  suppliersCreated: number;
  failed: { rowNo: number; code: string; message: string }[];
  skippedByName: { rowNo: number; code: string; name: string }[];
}>({
  created: 0,
  updated: 0,
  skusWritten: 0,
  imagesAttached: 0,
  costsWritten: 0,
  suppliersCreated: 0,
  failed: [],
  skippedByName: [],
});

const suppliers = ref(new Map<number, string>());

/**
 * 本地可判定的合格性：**款编码非空** 且 **SKU 单元格没有解析错误**。
 *
 * 为什么把 `skuErrors` 也算进来：预览表里能改的只有款编码和款式名，尺码/克重个数对不上
 * 这类问题只能回 Excel 改。把这种行标成"待导入"，用户提交后才发现被跳过，等于白等一次。
 * 其余（超长、供应商对不上、编码已存在）以库层校验为准。
 */
function rowOk(r: ProductImportRowResult): boolean {
  return String(r.code || '').trim() !== '' && r.skuErrors.length === 0;
}

/**
 * 用户编辑款编码时清除「自动生成」标记。
 * 编辑即视为用户接管了这个编码，不再显示「自动」徽标。
 */
function clearCodeAutoGenerated(r: ProductImportRowResult): void {
  if (r.codeAutoGenerated) {
    r.codeAutoGenerated = false;
  }
}

const importable = computed(() => rows.value.filter(rowOk));
const errorRows = computed(() => rows.value.filter((r) => !rowOk(r)));
const warnCount = computed(() => issues.value.filter((x) => x.level === 'warning').length);

/** 款式名在库内已存在的行（可供「同名款」开关处置的那一批） */
const dupNameRows = computed(() => rows.value.filter((r) => rowOk(r) && r.nameMatched));
/** 真的会被提交的行：合格 **且** 没被「同名款：跳过」拦下 */
const willSubmit = computed(() =>
  sameName.value === 'skip' ? importable.value.filter((r) => !r.nameMatched) : importable.value
);

/** 有问题的行 = 本地判不合格 **或** 宿主给了 error 级 issue */
const problemRows = computed(() => rows.value.filter((r) => !rowOk(r) || issueOf(r.rowNo) !== ''));
const visibleRows = computed(() => (onlyProblems.value ? problemRows.value : rows.value));
const hiddenCount = computed(() => rows.value.length - visibleRows.value.length);

/**
 * 挂在**不存在的行**上的提示（抽图失败、"第 N 行插了图但那里不是数据行"…）。
 * 这些消息如果只留在 issues 里，界面上一条都看不到 —— 而被它们描述的现象
 * （"导入成功但图没进来"）恰恰是最需要被说出来的。
 */
const looseNotes = computed(() =>
  issues.value.filter((x) => !rows.value.some((r) => r.rowNo === x.rowNo))
);

/** 计算成功导入的款编码明细 */
const successCodes = computed(() => {
  const failedCodes = new Set(result.failed.map((f) => f.code));
  const skippedCodes = new Set(result.skippedByName.map((f) => f.code));
  return rows.value
    .filter((r) => r.ok && !failedCodes.has(r.code) && !skippedCodes.has(r.code))
    .map((r) => ({
      code: r.code,
      name: r.name,
      autoGenerated: r.codeAutoGenerated,
      fromName: r.codeFromName,
    }));
});

function issueOf(rowNo: number): string {
  return issues.value
    .filter((x) => x.rowNo === rowNo && x.level === 'error')
    .map((x) => x.message)
    .join('；');
}

/** 「颜色」列：一行一个款，但同款多行会合并 ⇒ 这里可能出现多个颜色 */
function colorsOf(r: ProductImportRowResult): string {
  return [...new Set(r.skus.map((s) => s.color))].filter(Boolean).join('、');
}

/**
 * 「尺码」「克重」两列：按颜色分段。单个颜色时直接是 `M,L,XL`（与导出的写法一致），
 * 颜色多于一个时才加前缀 —— 否则"红 M,L / 蓝 S"会被读成同一串尺码。
 */
function skuCell(r: ProductImportRowResult, kind: 'size' | 'weight'): string {
  if (!r.skus.length) return '';
  const order: string[] = [];
  const groups = new Map<string, string[]>();
  for (const s of r.skus) {
    const c = s.color || '（无颜色）';
    if (!groups.has(c)) {
      groups.set(c, []);
      order.push(c);
    }
    groups.get(c)!.push(kind === 'size' ? s.size : s.weightG > 0 ? String(s.weightG) : '');
  }
  const multi = order.length > 1;
  return order
    .map((c) => {
      const vals = groups.get(c)!.join(',');
      return multi ? `${c}：${vals}` : vals;
    })
    .join(' · ');
}

function supplierName(id: number): string {
  return suppliers.value.get(Number(id)) || `#${id}`;
}

/** 预览「进价」列（元，两位小数）；留空/没填显示「—」，与列表页同口径 */
function costText(r: ProductImportRowResult): string {
  return r.costCents === null ? '—' : (r.costCents / 100).toFixed(2);
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
    imagesFound.value = preview.imagesFound;
    imagesLocated.value = preview.imagesLocated;
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
    const r = await commitProductImport(rows.value, mode.value, sameName.value);
    rows.value = r.rows.map((x) => ({ ...x }));
    issues.value = r.issues;
    result.created = r.created;
    result.updated = r.updated;
    result.skusWritten = r.skusWritten;
    result.imagesAttached = r.imagesAttached;
    result.costsWritten = r.costsWritten;
    result.suppliersCreated = r.suppliersCreated ?? 0;
    // 防御：桥/库层回了 undefined 时不能让 `result.skippedByName.length` 抛 —— 那会把一次
    // 成功的导入变成一屏报错（模板里读的是 `.length`，undefined 会直接炸）。
    result.skippedByName = Array.isArray(r.skippedByName) ? r.skippedByName : [];
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

/** 提交后仍未进来的行（本地不合格 + 库层冲突 + 按选择跳过的同名款） */
const remaining = computed(() => {
  const failedRows = new Set(result.failed.map((f) => f.rowNo));
  const skippedRows = new Set(result.skippedByName.map((f) => f.rowNo));
  return rows.value.filter((r) => !rowOk(r) || failedRows.has(r.rowNo) || skippedRows.has(r.rowNo));
});

const remainingReasons = computed(() => {
  const parts: string[] = [];
  if (errorRows.value.length) parts.push(`${errorRows.value.length} 行编码为空，或尺码/克重对不上`);
  if (result.skippedByName.length) parts.push(`${result.skippedByName.length} 行同名款按你的选择跳过`);
  if (result.failed.length) parts.push(`${result.failed.length} 行编码已存在且选择了「跳过不覆盖」`);
  return parts.join('，') || '原因见预览';
});

function backToPick(): void {
  step.value = 'pick';
}

function backToPreview(): void {
  result.created = 0;
  result.updated = 0;
  result.skusWritten = 0;
  result.imagesAttached = 0;
  result.costsWritten = 0;
  result.suppliersCreated = 0;
  result.failed = [];
  result.skippedByName = [];
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
/* 文件级提示（抽图失败 / 图没归位）：容易被当成"又是那些小字"忽略掉，所以给它一条竖线 */
.im-loose {
  flex-shrink: 0;
  margin: 8px 16px 0;
  padding-left: 14px;
  border-left: 2px solid var(--wb-warning);
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-text-muted);
  list-style: none;
}
.im-imgs {
  color: var(--wb-text);
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
.im-c-img {
  width: 68px;
  text-align: center;
  white-space: nowrap;
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

/* 自动生成款编码的标签 */
.im-code-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  /* ⚠️ 这一格的最小宽度**必须挂在容器上**（2026-10-10 修）：
     输入框自身是 `flex: 1`（= `flex-basis: 0`），它在表格 auto 布局里对列宽的贡献就是 0，
     于是那一列会缩到只剩右边那枚徽标的宽度 —— 编码明明有值，界面上却是**一个空输入框**，
     而且不报任何错（用户报的"款编码没有回显"就是这个）。 */
  min-width: 150px;
}
.im-code-cell input {
  flex: 1 1 auto;
  /* 允许缩（徽标要能站住），但**不塌成 0**：低于这个宽度用户就读不到编码了 */
  min-width: 96px;
}
.im-auto-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  background: var(--wb-info-bg, #e3f2fd);
  color: var(--wb-info, #1976d2);
  white-space: nowrap;
  flex-shrink: 0;
}
/* 「同名」= 款式名在库里已存在（编码取自那一款、默认覆盖更新它） */
.im-auto-tag--name {
  background: var(--wb-warning-soft, #fff4e5);
  color: var(--wb-warning, #b26a00);
}
/* 状态那一格里的「同名」：紧跟在 待导入/跳过 之后，不能把状态标签挤掉 */
.im-name-tag {
  margin-left: 6px;
}
/* 「新建」= 这一家供应商库里没有，导入时会建档 */
.im-auto-tag--new {
  margin-left: 6px;
}
.im-auto-tag-sm {
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--wb-info-bg, #e3f2fd);
  color: var(--wb-info, #1976d2);
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
