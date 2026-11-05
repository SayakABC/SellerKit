<template>
  <div class="wb-mask" @click.self="close">
    <aside class="wb-drawer pue" role="dialog" aria-modal="true" aria-label="拿货单编辑" data-act="pu-editor">
      <div class="wb-dialog__head pue__head">
        <span>拿货单 #{{ order.id }}</span>
        <span class="wb-tag" :class="order.status === 'submitted' ? 'is-on' : 'is-warn'">
          {{ order.status === 'submitted' ? '已提交' : '草稿' }}
        </span>
        <span class="wb-muted">厂家 {{ supplierName || `#${order.supplierId}` }}</span>
        <button class="pue__x" type="button" aria-label="关闭" data-act="pue-close" @click="close">
          ✕
        </button>
      </div>

      <div class="wb-dialog__body pue__body">
        <p v-if="order.status === 'submitted'" class="wb-notice wb-notice--warn" data-act="pue-submitted-note">
          {{ submittedNotice }}
        </p>

        <!-- 色未定（2026-10-20）：说清后果 + 就地给入口。这两条只在真有未定行时出现。 -->
        <p v-if="autoFixedCount" class="wb-notice" data-act="pue-auto-color">
          已按款色自动补齐 {{ autoFixedCount }} 行颜色（该款只有一个色，能唯一确定）—— 保存后生效。
        </p>
        <p v-if="undecidedCount" class="wb-notice wb-notice--warn" data-act="pue-undecided-note">
          有 {{ undecidedCount }} 行颜色对不上现在的款色：这些件数会重复计入待拿、也取不到图。在行内「色未定 · 选一个」里定色（候选就是该款现有的色）。
        </p>

        <!-- 一行工具条：日期 + 提示 + 加行。原来日期（label 两行）与提示句各占一整行，
             两行都在挤正文区的纵向空间，且把操作拆到了上下两处（2026-10-10 重设计）。 -->
        <div class="pue__bar">
          <label class="pue__date">
            <span class="wb-muted">拿货日期</span>
            <input v-model="bizDate" class="wb-input wb-input--sm" type="date" data-act="pue-date" />
          </label>
          <span class="pue__hint wb-muted">单价可留空，点「取最近价」按同厂家同款色回填</span>
          <button type="button" class="wb-btn wb-btn--sm" data-act="pue-add" @click="addRow">
            + 加行
          </button>
        </div>

        <!-- 表列宽由 colgroup 固定（`table-layout: fixed`），款色列吃掉剩余宽度。
             2026-10-10 前表格固有宽度 658px > 抽屉内容区宽度 ⇒ 金额列被裁半边、
             行尾操作列落在视窗外（静默不可达）；现在 8 列恰好等于内容宽度，不再横溢出。
             ⚠️ 这两块**不要**再套 `<template>` 外壳：不带 v-if/v-for 的 `<template>`
             会被 Vue 当原生 template 元素渲染，子节点进 content 片段、整块不参与布局
             （2026-10-20 实测表格量到 0x0，行尾按钮"消失"）。 -->
        <div v-if="rows.length" class="wb-table-wrap">
          <table class="wb-table pue__table" data-act="pue-table">
            <colgroup>
              <col class="pue__c-img" />
              <col />
              <col class="pue__c-size" />
              <col class="pue__c-sug" />
              <col class="pue__c-qty" />
              <col class="pue__c-price" />
              <col class="pue__c-amt" />
              <col class="pue__c-ops" />
            </colgroup>
            <thead>
              <tr>
                <th class="pue__imgcell">图片</th>
                <th>款色</th>
                <th>尺码</th>
                <th class="wb-num">建议</th>
                <th class="wb-num">实拿</th>
                <th class="wb-num">单价(元)</th>
                <th class="wb-num">金额(元)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.uid">
                <td class="pue__imgcell">
                  <img
                    v-if="thumbOf(r)"
                    class="pue__thumb"
                    :src="thumbOf(r)"
                    alt=""
                    :data-act="`pue-img-${r.uid}`"
                  />
                  <span
                    v-else-if="resolvedNoImage(r)"
                    class="pue__noimg"
                    :data-act="`pue-noimg-${r.uid}`"
                    >缺图</span
                  >
                </td>
                <td>
                  <!-- 款色 = 款编码 + 颜色（都还能改，改完重查单价与行图）。
                       `pue__ghost`：身份数据默认长得像文字（无边框无底色），点进去才变输入框
                       —— 方框会读成"这里要我填什么"（2026-10-10 用户反馈）。
                       款名只作行内提示 —— 权威在产品库（ADR-002 D1），不在这里编辑 -->
                  <div class="pue__style">
                    <input
                      v-model="r.styleCode"
                      class="wb-input wb-input--sm pue__ghost pue__code"
                      placeholder="款编码"
                      :data-act="`pue-code-${r.uid}`"
                      @change="onCodeChange(r)"
                    />
                    <input
                      v-model="r.color"
                      class="wb-input wb-input--sm pue__ghost pue__color"
                      placeholder="颜色"
                      :data-act="`pue-color-${r.uid}`"
                      @change="onCodeChange(r)"
                    />
                  </div>
                  <!-- 「色未定」就地修复（2026-10-20）：历史明细只存了色名快照，色行改名后
                       两边对不上 ⇒ 这行既扣不掉"已拿"、也取不到图（用户实报"全待拿 + 图没了"）。
                       候选**只来自款色表**（该款真实存在的色），不猜、不编；选完立刻写回 id+色名。 -->
                  <div v-if="colorPickOf(r).length" class="pue__pick" :data-act="`pue-pick-wrap-${r.uid}`">
                    <select
                      class="wb-input wb-input--sm"
                      :value="''"
                      :data-act="`pue-pick-${r.uid}`"
                      @change="onPickColor(r, $event)"
                    >
                      <option value="">色未定 · 选一个</option>
                      <option v-for="c in colorPickOf(r)" :key="c.id" :value="c.id">
                        {{ c.color }}{{ c.hasImage ? '' : '（无图）' }}
                      </option>
                    </select>
                    <label v-if="sameCodeUndecided(r) > 0" class="pue__pick-same">
                      <input
                        v-model="applySame"
                        type="checkbox"
                        :data-act="`pue-pick-same-${r.uid}`"
                      />
                      同款其余 {{ sameCodeUndecided(r) }} 行一起
                    </label>
                  </div>
                  <div
                    v-if="r.styleName"
                    class="pue__name"
                    :title="r.styleName"
                    :data-act="`pue-name-${r.uid}`"
                  >
                    {{ r.styleName }}
                  </div>
                </td>
                <td>
                  <input
                    v-model="r.size"
                    class="wb-input wb-input--sm pue__ghost pue__cell"
                    placeholder="尺码"
                    :data-act="`pue-size-${r.uid}`"
                    @change="onSizeChange(r)"
                  />
                  <!-- 亚洲款加码：这一行的拿货码是换算来的，下单原文是另一码。
                       不写出来，用户看着 XL 会以为开单开错了（或手工"改回" L，把加码白做）。 -->
                  <div
                    v-if="r.orderSize && r.orderSize !== r.size"
                    class="pue__sub"
                    :data-act="`pue-ordersize-${r.uid}`"
                  >
                    下单 {{ r.orderSize }}
                  </div>
                </td>
                <td class="wb-num wb-muted">{{ r.suggestionQty || '—' }}</td>
                <td>
                  <input
                    v-model.number="r.qty"
                    class="wb-input wb-input--sm pue__cell wb-num"
                    type="number"
                    min="0"
                    step="1"
                    :data-act="`pue-qty-${r.uid}`"
                  />
                </td>
                <td>
                  <input
                    v-model="r.priceText"
                    class="wb-input wb-input--sm pue__cell wb-num"
                    type="number"
                    min="0"
                    step="0.01"
                    :data-act="`pue-price-${r.uid}`"
                  />
                </td>
                <td class="wb-num" :data-act="`pue-amt-${r.uid}`">{{ rowAmountText(r) }}</td>
                <td class="pue__ops">
                  <!-- 文字按钮，不是图标：↻ / ✕ 说不出含义（2026-10-10 用户反馈"完全不知道
                       是什么意思"）。与「拿了什么」列表的行尾动作同一套（.wb-link），窄列里竖排两行。 -->
                  <button
                    type="button"
                    class="wb-link pue__oplink"
                    title="按同厂家同款色的最近历史单价填入"
                    :data-act="`pue-fill-${r.uid}`"
                    @click="fillPrice(r)"
                  >
                    取最近价
                  </button>
                  <button
                    type="button"
                    class="wb-link wb-link--danger pue__oplink"
                    :data-act="`pue-delrow-${r.uid}`"
                    @click="removeRow(r.uid)"
                  >
                    删除
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="wb-empty" data-act="pue-empty">
          <p class="wb-empty__title">还没有明细行</p>
          <p class="wb-empty__desc">
            点「+ 加行」手工添，或者回「按厂家」选好厂家，按清单一键生成一张。
          </p>
        </div>
      </div>

      <div class="wb-dialog__foot pue__foot">
        <span class="pue__total">
          {{ footPrefix }}合计 <b data-act="pue-total">¥{{ money(totalCents) }}</b>
        </span>
        <button type="button" class="wb-btn" data-act="pue-cancel" :disabled="saving" @click="close">
          取消
        </button>
        <button
          type="button"
          class="wb-btn wb-btn--primary"
          data-act="pue-save"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
// 拿货单明细编辑（抽屉）。**金额口径只有一处**：明细行金额 = 实拿 × 单价，
// 合计与主进程 `purchase-db.computeTotal()` 同一公式（宿主保存时按同一公式重算落库，
// 界面这份只为实时显示）。
//
// 2026-10-20：**包价单分支删除**（真库 `mode='package'` 0 条、也没有创建入口，
// 留着只是第四套金额口径）。于是"只记总额"那条路径连同页头的模式标签一起没了 ——
// 拿货单只有一种形态，不需要一个恒为"明细"的标签去说明它。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { orderImageThumbBatch } from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import type { PurchaseOrder } from '@/types';
import { centsToYuan, money, priceHistory, styleColorOptions, styleImages, updateOrder, yuanToCents } from '../purchase';

const props = defineProps<{
  order: PurchaseOrder;
  /** 厂家名（只读展示；厂家归属在创建时锁定） */
  supplierName: string;
}>();

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

interface EditRow {
  /** 行标识：**不能用数组下标** —— 删中间一行时下标会串，输入框的值会串到别的行上 */
  uid: number;
  styleCode: string;
  styleName: string;
  /**
   * 款色 id（**身份**）。0 = 还没定（老单据）。
   *
   * ⚠️ 必须**原样带回**：宿主保存是「删明细 + 整批重插」（`updatePurchaseOrder`），
   * 少带一个字段就等于把它清空 —— 而清空的后果是这条明细的"已拿"从此只能靠色名匹配，
   * 色名一变就回到"用户实报的全待拿"。
   */
  styleColorId: number;
  color: string;
  /** **拿货码**（照它拿货；亚洲款加码后与下单码不同） */
  size: string;
  /** 下单码（订单原文）；'' = 未加码。只用于展示"为什么是 XL"与追溯，改码时不跟着改 */
  orderSize: string;
  qty: number;
  /** 单价（元）**按用户输入的原文**保留，避免"输入 12.5 → 被改写成 12.50"抢光标 */
  priceText: string;
  suggestionQty: number;
}

let uidSeq = 0;
const nextUid = (): number => ++uidSeq;

const bizDate = ref(props.order.bizDate || '');
const rows = ref<EditRow[]>(
  (props.order.items ?? []).map((it) => ({
    uid: nextUid(),
    styleCode: it.styleCode ?? '',
    styleName: it.styleName ?? '',
    styleColorId: Number(it.styleColorId) || 0,
    color: it.color ?? '',
    size: it.size ?? '',
    orderSize: it.orderSize ?? '',
    qty: Number(it.qty) || 0,
    priceText: it.priceCents ? String(centsToYuan(it.priceCents)) : '',
    suggestionQty: Number(it.suggestionQty) || 0,
  }))
);
const saving = ref(false);

/* ---- 「色未定」修复（2026-10-20）------------------------------------------------------
 * 背景：历史拿货明细只存了**色名快照**（且是占位「未分类」）。色行被归色改写后，
 *   明细与现库对不上 ⇒ `takenKey` 匹配不到（全变"待拿"）+ 取图返回 null（"图全没了"）。
 * 修法：把行绑回**款色 id**。候选只来自款色表（该款真实有的色），绝不按"款+码唯一色"猜。
 * 自动边界（产品原则：能由事实唯一推导的一律自动，但必须说出来）：
 *   只处理「色名是占位/空」且「该款恰好 1 个色行」的行 —— 这种情况答案是唯一的。
 */
type ColorOption = { id: number; color: string; hasImage: boolean };
/** 款编码（大写）→ 该款的色行 */
const colorOptions = ref<Record<string, ColorOption[]>>({});
/** 自动补齐的行数（打开时算一次，只用于提示"我改了什么"——静默改数据比不改更糟） */
const autoFixedCount = ref(0);
/** "同款其余行一起改" —— **默认不勾**：同款真的可能有多个色，默认勾会把两个色强行并成一个（发错货） */
const applySame = ref(false);

/** 占位色名（与主进程 `MAPPED_FALLBACK_COLOR` 同一字面量）—— 它是"还没定"，不是业务色 */
const PLACEHOLDER_COLOR = '未分类';
const isPlaceholder = (c: string): boolean => {
  const t = c.trim();
  return !t || t === PLACEHOLDER_COLOR;
};

/** 该行要不要给"选色"下拉：只有**未定**且该款有 2 个以上候选时才需要问人 */
function colorPickOf(r: EditRow): ColorOption[] {
  if (r.styleColorId > 0) return [];
  const list = colorOptions.value[r.styleCode.trim().toUpperCase()] ?? [];
  return list.length > 1 ? list : [];
}

/** 同款、同样未定的其它行数（"一起改"的覆盖面） */
function sameCodeUndecided(r: EditRow): number {
  const code = r.styleCode.trim().toUpperCase();
  if (!code) return 0;
  return rows.value.filter(
    (x) => x.uid !== r.uid && x.styleCode.trim().toUpperCase() === code && x.styleColorId <= 0
  ).length;
}

/** 保存前的"还没定色"行数（提示条用） */
const undecidedCount = computed(
  () => rows.value.filter((r) => r.styleCode.trim() && colorPickOf(r).length > 0).length
);

/**
 * 拉候选色 + 自动补齐**唯一解**的行。
 * 失败静默（不拦编辑器）：候选取不到只是少了"选色"入口，色名仍可手填。
 */
async function resolveColorOptions(): Promise<void> {
  const codes = [...new Set(rows.value.map((r) => r.styleCode.trim().toUpperCase()).filter(Boolean))];
  if (!codes.length) return;
  try {
    const map = await styleColorOptions(codes);
    // 键统一大写（主进程按 UPPER(款编码) 返回），调用方也用大写查 —— 大小写不该造成"找不到色"
    const norm: Record<string, ColorOption[]> = {};
    for (const [k, v] of Object.entries(map ?? {})) norm[String(k).toUpperCase()] = v ?? [];
    colorOptions.value = norm;
    let fixed = 0;
    for (const r of rows.value) {
      if (r.styleColorId > 0) continue;
      if (!r.styleCode.trim() || !isPlaceholder(r.color)) continue;
      const list = norm[r.styleCode.trim().toUpperCase()] ?? [];
      // 唯一解才自动（多个色 ⇒ 必须人来定，猜一个就是静默错色）
      if (list.length !== 1) continue;
      r.styleColorId = list[0].id;
      r.color = list[0].color;
      fixed += 1;
    }
    autoFixedCount.value += fixed;
    if (fixed) {
      await resolveImages(
        rows.value.map((r) => ({ styleCode: r.styleCode, color: r.color, size: r.size, styleColorId: r.styleColorId }))
      );
    }
  } catch {
    /* 候选取不到 → 只是没有下拉，不拦保存 */
  }
}

/** 选了一个色：写回 id + 色名（可选同款其它未定行一起），并刷新这几行的图 */
async function onPickColor(r: EditRow, e: Event): Promise<void> {
  const id = Number((e.target as HTMLSelectElement | null)?.value) || 0;
  const list = colorOptions.value[r.styleCode.trim().toUpperCase()] ?? [];
  const hit = list.find((c) => c.id === id);
  if (!hit) return;
  const targets = applySame.value
    ? rows.value.filter((x) => x.styleCode.trim().toUpperCase() === r.styleCode.trim().toUpperCase() && x.styleColorId <= 0)
    : [r];
  for (const t of targets) {
    t.styleColorId = hit.id;
    t.color = hit.color;
  }
  toast(
    targets.length > 1
      ? `已把 ${hit.color} 写到同款 ${targets.length} 行（保存后生效）`
      : `已设为 ${hit.color}（保存后生效）`,
    'success'
  );
  await resolveImages(
    targets.map((t) => ({ styleCode: t.styleCode, color: t.color, size: t.size, styleColorId: t.styleColorId }))
  );
}

/** 页脚前缀（明细行数 —— 拿货单只有明细一种形态，包价单 2026-10-20 已删） */
const footPrefix = computed(() => `共 ${rows.value.length} 行 · `);

/**
 * 行图：键 = `款编码|款色|尺码`。
 * ⚠️ **尺码是键的一部分**（2026-10-11 用户报"拿货单明细的图片都是一样的"）：订单 Excel 里
 * 每个商品行各有自己的图（落在 `oi_order_items.image_id`），而明细行的粒度正是「款色 × 尺码」——
 * 只按款色取图 ⇒ 同一款的所有行（不同尺码、各来自不同商品）全显示成同一张，且多数还不是本行那件。
 * `imgPaths` 的值 `undefined` = 还没查过、`null` = 查过但没有 —— 两者必须分开，
 * 否则"还没查"会显示成"缺图"（打开瞬间整表闪一遍假缺图）。
 */
const imgPaths = ref<Record<string, string | null>>({});
/** 本地路径 → dataUrl（缩略图缓存） */
const thumbs = ref<Record<string, string>>({});

// 缓存键含**款色 id**：同一个色名可能先后指向不同的色行（选色 / 改色名后 id 变了），
// 只按文本做键会把"上一次查到的 null"复用给新的身份 ⇒ 改完色仍然显示缺图。
const pairKey = (styleCode: string, color: string, size: string, styleColorId = 0): string =>
  `${styleCode.trim()}|${color.trim()}|${size.trim()}|${Number(styleColorId) || 0}`;

function thumbOf(r: EditRow): string {
  const p = imgPaths.value[pairKey(r.styleCode, r.color, r.size, r.styleColorId)];
  return p ? thumbs.value[p] ?? '' : '';
}

/** 查过且确实没有图才给「缺图」占位；还没查过时留空位（不闪）。款编码没填 = 还没填，不算缺图 */
function resolvedNoImage(r: EditRow): boolean {
  if (!r.styleCode.trim()) return false;
  return imgPaths.value[pairKey(r.styleCode, r.color, r.size, r.styleColorId)] === null;
}

/**
 * 解析一组行的款色图（去重、跳过空款编码；只查还没查过的对）。
 * **失败静默**：图是装饰 —— 查不到/查挂了都只是空占位，绝不拦保存与单价这条主链路。
 *
 * ⚠️ 必须把 `styleColorId` 一起带上：主进程有 id 就**只按 id** 取图（色名是可变标签，
 * 改名后按色名取会静默变 null —— 用户实报"拿货单图片全没了"）。
 */
type ImagePair = { styleCode: string; color: string; size: string; styleColorId?: number };

async function resolveImages(pairs: ImagePair[]): Promise<void> {
  const todo = new Map<string, ImagePair>();
  for (const p of pairs) {
    if (!p.styleCode.trim()) continue;
    const key = pairKey(p.styleCode, p.color, p.size, p.styleColorId);
    if (key in imgPaths.value) continue;
    todo.set(key, p);
  }
  if (!todo.size) return;
  try {
    const entries = [...todo.entries()];
    const found = await styleImages({ items: entries.map(([, p]) => p) });
    const fresh: string[] = [];
    entries.forEach(([key], i) => {
      const path = found[i] ?? null;
      imgPaths.value[key] = path;
      if (path) fresh.push(path);
    });
    const missing = [...new Set(fresh.filter((p) => !thumbs.value[p]))];
    if (!missing.length) return;
    const t = await orderImageThumbBatch(missing.map((localPath) => ({ localPath, maxEdge: 96 })));
    if (!t.success) return;
    const urls = t.data?.dataUrls ?? [];
    missing.forEach((p, i) => {
      const url = urls[i];
      if (url) thumbs.value[p] = url;
    });
  } catch {
    /* 图是装饰：空着就行（下次改款色会再试），不打断录入 */
  }
}

onMounted(() => {
  void resolveImages(
    rows.value.map((r) => ({ styleCode: r.styleCode, color: r.color, size: r.size, styleColorId: r.styleColorId }))
  );
  // 候选色 + 唯一解自动补齐（与取图并行；两者互不依赖）
  void resolveColorOptions();
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

/**
 * Esc 关抽屉（2026-10-17 评审 P2）。桌面用户 Esc = 关掉眼前这层，是肌肉记忆；
 * 项目里 `AccountEditor` / `BatchEditDrawer` 等弹层都已有，本抽屉是漏掉的那一个。
 *
 * ⚠️ **确认弹层没有一起改**（那是有意的）：`ConfirmDialog` 会被叠在别的弹层之上使用，
 *    给它加常驻 window 监听 ⇒ 按一下 Esc 会把确认层与它下面那层一起关掉。
 *    正确的做法是在遮罩层做统一的"只关最上层"，那是另一处设计缺口，不在这个 P2 里顺手引入。
 * ⚠️ 与取消按钮同一个出口（`close()`），不另走一条路径 —— 两条路径迟早分叉。
 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}

function rowCents(r: EditRow): number {
  return Math.max(0, Math.round(Number(r.qty) || 0)) * yuanToCents(r.priceText);
}
const rowAmountCents = (r: EditRow): number => rowCents(r);

/**
 * 行金额。**没填单价就不写 ¥0.00**（2026-10-17 评审 P2）：
 * 0 元会被读成"这一行是白送的"，而它实际是"还不知道多少钱" ——
 * 与清单上「无进价 → 不写 0」同一条规矩（0 元 ≠ 不知道）。
 * 新加的空行、填了数量还没问到价的行，都显示「—」。
 */
function rowAmountText(r: EditRow): string {
  // ⚠️ **变异实测**：`priceText` 是 number 输入框的 v-model，敲价后 Vue 把它 coerce 成
  //    **number**（不是字符串）—— 直接 .trim() 抛 TypeError，崩在渲染期 ⇒ Vue 把整个
  //    编辑器卸载（"一敲单价编辑器就消失"，真实用户必踩）。防御式 String() 包一层，
  //    string / number 都安全；`rowCents` 本就用 Number() 吃两种（冒烟守卫：敲单价那条）。
  const t = String(r.priceText ?? '').trim();
  return t ? money(rowCents(r)) : '—';
}

const totalCents = computed(() => rows.value.reduce((s, r) => s + rowCents(r), 0));

const submittedNotice =
  '这张单已提交：改动会立即影响对账金额、待拿货缺口与「统计」里的成本。';

function addRow(): void {
  rows.value.push({
    uid: nextUid(),
    styleCode: '',
    styleName: '',
    styleColorId: 0,
    color: '',
    size: '',
    orderSize: '',
    qty: 0,
    priceText: '',
    suggestionQty: 0,
  });
}

function removeRow(uid: number): void {
  rows.value = rows.value.filter((r) => r.uid !== uid);
}

/**
 * 款色 / 款编码 改完且**单价还是空的**时，自动带出同厂家同款色的最近单价。
 * 只在空价时自动填：已有价格的是用户自己定的，不该被覆盖。
 */
async function onCodeChange(r: EditRow): Promise<void> {
  // 改款编码 / 色名后，身份（styleColorId）必须跟着重算：
  // 对不上就归零（宁可回到"色未定"重新问，也不要出现"id 指着一个色、界面写着另一个色"——
  // 那种不一致会让已拿扣到错的色上，且不报错）。
  const code = r.styleCode.trim().toUpperCase();
  if (code && !(code in colorOptions.value)) await resolveColorOptions();
  syncColorIdFromText(r);
  // 图先刷新 —— 下面的"已有价就不查历史价"会早退，别让它顺带挡住取图
  void resolveImages([{ styleCode: r.styleCode, color: r.color, size: r.size, styleColorId: r.styleColorId }]);
  if (yuanToCents(r.priceText) > 0) return;
  const cents = await priceHistory({
    supplierId: props.order.supplierId,
    styleCode: r.styleCode.trim(),
    color: r.color.trim(),
  }).catch(() => 0);
  if (cents > 0) r.priceText = String(centsToYuan(cents));
}

/** 色名手改后把身份对上：能唯一命中该款某个色行就绑 id，否则归零（回到"色未定"） */
function syncColorIdFromText(r: EditRow): void {
  const list = colorOptions.value[r.styleCode.trim().toUpperCase()] ?? [];
  const t = r.color.trim();
  const hit = t ? list.find((c) => c.color.trim() === t) : undefined;
  r.styleColorId = hit ? hit.id : 0;
}

/** 尺码改完只重查这一行的图 —— 尺码是取图键的一部分，但它与单价无关，**不碰历史价** */
function onSizeChange(r: EditRow): void {
  // 手工改了拿货码 ⇒ 这条不再是"加码换算的结果"，下单码不能继续挂着（否则追溯会指错）
  if (r.orderSize && r.orderSize !== r.size) r.orderSize = '';
  void resolveImages([{ styleCode: r.styleCode, color: r.color, size: r.size, styleColorId: r.styleColorId }]);
}

/** 「取最近价」：**强制**回填（用户主动点的），查不到如实说一句 */
async function fillPrice(r: EditRow): Promise<void> {
  const code = r.styleCode.trim();
  if (!code) return toast('请先填款编码', 'error');
  try {
    const cents = await priceHistory({
      supplierId: props.order.supplierId,
      styleCode: code,
      color: r.color.trim(),
    });
    if (cents <= 0) return toast('没查到该款色的历史单价', 'info');
    r.priceText = String(centsToYuan(cents));
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '查历史价失败', 'error');
  }
}

async function save(): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bizDate.value)) return toast('拿货日期格式不正确', 'error');
  const items = rows.value
    .filter((r) => r.styleCode.trim())
    .map((r) => ({
      styleCode: r.styleCode.trim(),
      styleName: r.styleName,
      // 身份必须原样带回（宿主是删+重插，漏传 = 静默清空 —— 见 `EditRow.styleColorId`）
      styleColorId: r.styleColorId,
      color: r.color,
      size: r.size,
      // 下单码原样带回：宿主是"删明细 + 重插"，漏传 = 这条的"为什么拿 XL"被清空
      // （主进程虽会按 (款,色,码) 回填旧值，但用户改过尺码时那是另一条事实，不该沿用）。
      orderSize: r.orderSize,
      qty: Math.max(0, Math.round(Number(r.qty) || 0)),
      priceCents: yuanToCents(r.priceText),
      suggestionQty: Math.max(0, Math.round(Number(r.suggestionQty) || 0)),
    }));
  if (rows.value.length > 0 && items.length === 0) {
    return toast('明细不能全是空行（没填款编码的行不会被保存）', 'error');
  }
  saving.value = true;
  try {
    await updateOrder({
      id: props.order.id,
      bizDate: bizDate.value,
      items,
    });
    emit('saved');
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : '保存失败', 'error');
  } finally {
    saving.value = false;
  }
}

function close(): void {
  emit('close');
}
</script>

<style scoped>
/* 抽屉加宽 560 → 620：560px 时内容区只有 527px，而 8 列明细表的固有宽度 658px ——
   「金额(元)」被裁半边、行尾操作列落在视窗外（静默不可达，2026-10-10 截图取证）。
   620px ⇒ 内容区 587px，配合下表列宽恰好一行放下。 */
.pue {
  width: 620px;
}

.pue__head {
  align-items: center;
}

.pue__x {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 14px;
  cursor: pointer;
}

.pue__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 一行工具条：日期 + 提示 + 加行 */
.pue__bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pue__date {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.pue__date .wb-muted {
  font-size: 12px;
}

.pue__hint {
  flex: 1;
  min-width: 0;
  font-size: 12px;
}

/* 列宽固定（colgroup）+ fixed 布局：数字列给足两位数小数，款色列吃剩余宽度。
   行 padding 收到 5px 压行高（原来 9px，行高 77px 读起来松垮） */
.pue__table {
  table-layout: fixed;
  width: 100%;
}

.pue__table th,
.pue__table td {
  padding: 5px 6px;
}

.pue__c-img {
  width: 48px;
}

/* 第二列（款色）不给宽度：吃掉剩余空间 */
.pue__c-size {
  width: 54px;
}

.pue__c-sug {
  width: 40px;
}

.pue__c-qty {
  width: 60px;
}

.pue__c-price {
  width: 80px;
}

.pue__c-amt {
  width: 76px;
}

.pue__c-ops {
  /* 66px = 「取最近价」12px 文字 + 链接内边距 + 单元格 4px 内边距（60px 会把它挤断行） */
  width: 66px;
}

/* 行悬浮：横着扫 8 列时"这行是谁"要跟得住。
   连同首格（sticky 列自带底色，不换色会在横滚时断层）一起换。 */
.pue__table tbody tr:hover td {
  background: var(--wb-hover);
}

/* 实拿/单价：输入框撑满单元格（不撑满看着像装饰）；尺码也用它控宽（外观另由 .pue__ghost 管） */
.pue__cell {
  width: 100%;
  min-width: 0;
}

/* 尺码格下方的那行小字（下单码）：加码款的 `XL` 旁边标"下单 L" —— 它不是输入项，别做成链接 */
.pue__sub {
  margin-top: 2px;
  font-size: 11px;
  color: var(--wb-muted, #8a8f98);
  white-space: nowrap;
}

/* 款色 / 尺码 = **身份数据**（清单带过来的），默认看起来是文字：无边框、无底色；
   悬浮只出一条边框提示"可点"；聚焦才还原成完整输入框。
   （2026-10-10 用户反馈："款色和尺码为什么要用输入框的样式？" —— 满屏方框会被读成
   "这里全都要我填"。）
   ⚠️ 用 :focus 而不是 :focus-visible：它常态长得像纯文字，鼠标点进去若不还原输入框外观，
      等于没有任何"我正在编辑"的反馈（基座的 :focus-visible 只服务键盘 Tab）。 */
.pue__ghost {
  border-color: transparent;
  background-color: transparent;
}

.pue__ghost:hover {
  border-color: var(--wb-border);
}

.pue__ghost:focus {
  border-color: var(--wb-focus);
  box-shadow: 0 0 0 3px var(--wb-focus-ring);
  background-color: var(--wb-surface-2);
}

.pue__imgcell {
  width: 48px;
}

/* 行图：36px 方图；查过没有才显示「缺图」，未查过留空 */
.pue__thumb {
  display: block;
  width: 36px;
  height: 36px;
  object-fit: cover;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
}

.pue__noimg {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px dashed var(--wb-border);
  border-radius: var(--wb-radius-sm);
  font-size: 10px;
  color: var(--wb-text-muted);
}

/* 款色 = 款编码 + 颜色（两个输入一行，placeholder 认字段，不再用「·」占位）＋ 款名灰字一行 */
.pue__style {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pue__code {
  flex: 0 1 92px;
  min-width: 56px;
}

.pue__color {
  flex: 1 1 58px;
  min-width: 0;
}

.pue__name {
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--wb-text-muted);
}

/* 「色未定」选色行：只在未定且该款有多个候选时出现（见 `colorPickOf`）。
   横向排（下拉吃剩余宽度 + 复选框不换行）—— 竖排会把行高再抬一截，一屏少看两行。 */
.pue__pick {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.pue__pick select {
  flex: 1;
  min-width: 0;
}

.pue__pick-same {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--wb-text-muted);
  white-space: nowrap;
}

/* 行尾文字按钮「取最近价 / 删除」竖排两行（与「拿了什么」列表同一套 .wb-link）。
   12px：.wb-link 基座 13px 时「取最近价」宽 60px，塞不进 66px 列。
   ⚠️ 覆盖 td 的 5px/6px 内边距要连 .pue__table 一起写（`.pue__table td` 是 0-1-1，压过单个类）。 */
.pue__table .pue__ops {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 4px;
}

.pue__oplink {
  font-size: 12px;
}

.pue__foot {
  align-items: center;
}

/* 合计推到最左：`.wb-dialog__foot` 是 flex-end，右侧留给两个按钮 */
.pue__total {
  margin-right: auto;
  font-size: 12.5px;
  color: var(--wb-text-muted);
}

.pue__total b {
  font-size: 15px;
  color: var(--wb-text);
  font-variant-numeric: tabular-nums;
}
</style>
