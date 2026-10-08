<template>
  <div class="wb-mask ed-mask" @click.self="requestClose()">
    <aside class="wb-drawer ed-drawer" role="dialog" aria-modal="true" aria-label="产品编辑">
      <div class="wb-dialog__head ed-head">
        <span>{{ isEdit ? '编辑产品' : '新增产品' }}</span>
        <span v-if="isEdit" class="wb-mono wb-muted ed-head__code">{{ form.code }}</span>
        <button class="ed-x" type="button" aria-label="关闭" @click="requestClose()">✕</button>
      </div>

      <div class="wb-dialog__body ed-body">
        <!-- 保存模型**必须先说清**（UX-G3）：编辑模式是"离开输入框就写库"，不说明的话
             用户会继续找那个已经不存在的「保存」按钮。 -->
        <p v-if="isEdit" class="wb-notice" data-act="ed-autosave-hint">
          这一屏<b>边改边存</b>：字段离开输入框就写库了，底部只剩一个「完成」。
          <b>SKU 行不自动存</b>（一次要改几十行），改完按那一行的「保存」或下面的「保存全部改动」。
        </p>

        <label class="wb-field">
          <span class="wb-field__label">款编码 <i class="wb-field__req">*</i></span>
          <!-- 编辑时只读：编码是订单 / 采购 / 成本三域的关联锚点，改了会让历史数据指向另一个产品 -->
          <input
            v-model="form.code"
            class="wb-input"
            :readonly="isEdit"
            :class="{ 'is-readonly': isEdit }"
            placeholder="例：STYLE-001"
          />
          <span v-if="isEdit" class="wb-field__hint">
            编码是跨域关联的锚点，一经创建不可修改。要换编码请新建一个款，把旧款停用。
          </span>
        </label>

        <label class="wb-field">
          <span class="wb-field__label">款式名</span>
          <input v-model="form.name" class="wb-input" placeholder="例：折叠收纳箱 60L" @blur="autoSave" />
        </label>

        <div class="ed-row">
          <label class="wb-field">
            <span class="wb-field__label">供应商</span>
            <select v-model="form.supplierId" class="wb-input" @change="autoSave">
              <option :value="0">未关联</option>
              <option v-for="s in suppliers" :key="s.id" :value="s.id">
                {{ s.name || `#${s.id}` }}{{ s.productCount ? `（${s.productCount}）` : '' }}
              </option>
            </select>
            <span v-if="!suppliers.length" class="wb-field__hint">
              还没有供应商 —— 到「供应商」页签新增，这里只做关联。
            </span>
          </label>

          <label class="wb-field">
            <span class="wb-field__label">类目</span>
            <input v-model="form.category" class="wb-input" placeholder="例：家居收纳" @blur="autoSave" />
          </label>
        </div>

        <label class="wb-field">
          <span class="wb-field__label">状态</span>
          <select v-model="form.status" class="wb-input" @change="autoSave">
            <option value="active">启用</option>
            <option value="archived">停用</option>
          </select>
          <span class="wb-field__hint">停用只做标记，不物理删除 —— 编码一经使用永不复用。</span>
        </label>

        <label class="wb-field">
          <span class="wb-field__label">备注</span>
          <textarea v-model="form.note" class="wb-input" rows="2" placeholder="选填" @blur="autoSave"></textarea>
        </label>

        <!-- 主图：窄接口立即保存（不等底部「保存」） -->
        <div class="wb-field">
          <span class="wb-field__label">主图</span>
          <div v-if="isEdit" class="ed-img">
            <img v-if="imgUrl" :src="imgUrl" class="ed-img__pic" alt="主图" />
            <div v-else class="ed-img__empty">暂无主图</div>
            <div class="ed-img__ops">
              <button class="wb-btn wb-btn--sm" type="button" :disabled="imgBusy" @click="pickImage">
                {{ imgBusy ? '处理中…' : imgUrl ? '更换' : '上传主图' }}
              </button>
              <button
                v-if="imgUrl"
                class="wb-btn wb-btn--sm"
                type="button"
                :disabled="imgBusy"
                @click="removeImage"
              >
                移除
              </button>
            </div>
          </div>
          <span v-else class="wb-field__hint">先保存产品，才能上传主图与维护 SKU。</span>
        </div>

        <!-- SKU 子表：颜色 × 尺码组合；行内即时保存；克重口径与 pl_item_weights 一致（克，整数） -->
        <div v-if="isEdit" class="wb-field ed-skus">
          <span class="wb-field__label">SKU（颜色 / 尺码 / 编码 / 克重）</span>
          <div v-if="skuLoading" class="wb-field__hint">SKU 读取中…</div>
          <template v-else>
            <!-- 批量生成：颜色列表 × 尺码拖选。这是本产品最有辨识度的一处交互 ——
                 服装款一次要建几十个组合，逐个新增不可行；拖选能一次圈一排码。 -->
            <div class="ed-gen">
              <input
                v-model="genColor"
                class="wb-input"
                placeholder="输入颜色后回车添加（可多个，如：黑色、白色）"
                aria-label="新增颜色"
                @keydown.enter.prevent="addGenColor"
                @blur="flushGenColor"
              />
              <div v-if="genColors.length" class="ed-chips">
                <button
                  v-for="(c, i) in genColors"
                  :key="c"
                  class="ed-chip ed-chip--color"
                  type="button"
                  title="点击移除"
                  @click="removeGenColor(i)"
                >
                  {{ c }} ×
                </button>
              </div>
              <div class="ed-gen__label">尺码（点击选中；按住拖动可连选 / 连消；键盘用回车切换）</div>
              <div v-for="g in sizeGroups" :key="g.name" class="ed-chips" :data-size-group="g.name">
                <span class="ed-chips__name">{{ g.name }}</span>
                <button
                  v-for="s in g.items"
                  :key="`${g.name}-${s}`"
                  class="ed-chip ed-chip--size"
                  type="button"
                  :class="{ 'ed-chip--on': selSizes[s] }"
                  :aria-pressed="!!selSizes[s]"
                  @mousedown.prevent="sizePress(s)"
                  @mouseenter="sizeEnter(s)"
                  @mouseup="sizeLeave()"
                  @keydown.enter.prevent="sizeToggle(s)"
                  @keydown.space.prevent="sizeToggle(s)"
                >
                  {{ s }}
                </button>
                <!-- 「全选本组 / 清空本组」（报告 P2-2）：一整排码逐个点太费劲，
                     而拖选是**纯鼠标约定**（触屏没有 mouseenter、键盘走不到）。
                     两个按钮把"整组"这件事变成一次点击 —— 键盘也够得着。 -->
                <button
                  class="wb-link ed-chips__bulk"
                  type="button"
                  data-act="size-all"
                  :data-size-group="g.name"
                  @click="setGroupAll(g.items, true)"
                >
                  全选本组
                </button>
                <button
                  class="wb-link ed-chips__bulk"
                  type="button"
                  data-act="size-none"
                  :data-size-group="g.name"
                  @click="setGroupAll(g.items, false)"
                >
                  清空本组
                </button>
              </div>
              <div class="ed-gen__line">
                <input
                  v-model="genSize"
                  class="wb-input ed-gen__size"
                  placeholder="自定义尺码，回车加入"
                  aria-label="自定义尺码"
                  @keydown.enter.prevent="addGenSize"
                />
                <input
                  v-model.number="genWeight"
                  class="wb-input ed-gen__weight"
                  type="number"
                  min="0"
                  placeholder="默认克重(选填)"
                  aria-label="默认克重"
                />
                <button
                  class="wb-btn wb-btn--primary"
                  type="button"
                  :disabled="skuBusy || !genColors.length || !selCount"
                  @click="generate"
                >
                  生成组合
                </button>
              </div>
              <span class="wb-field__hint">
                生成 = 已选颜色 × 已选尺码的全部组合（已存在的自动跳过）；生成后逐行改克重，再「保存全部改动」。
              </span>
            </div>

            <div v-for="row in skuRows" :key="row.key" class="ed-sku" :class="{ 'ed-sku--dirty': row.dirty }">
              <span v-if="isLegacy(row)" class="ed-tag" :title="`历史 SKU，原名称：${row.name}`">旧</span>
              <input
                v-model="row.color"
                class="wb-input ed-sku__color"
                placeholder="颜色"
                aria-label="颜色"
                @input="row.dirty = true"
              />
              <input
                v-model="row.size"
                class="wb-input ed-sku__size"
                placeholder="尺码"
                aria-label="尺码"
                @input="row.dirty = true"
              />
              <input
                v-model="row.code"
                class="wb-input ed-sku__code"
                placeholder="编码"
                aria-label="编码"
                @input="row.dirty = true"
              />
              <input
                v-model.number="row.weightG"
                class="wb-input ed-sku__weight"
                type="number"
                min="0"
                placeholder="克重"
                aria-label="克重"
                @input="row.dirty = true"
              />
              <button
                class="wb-btn wb-btn--sm"
                type="button"
                :class="{ 'wb-btn--primary': row.dirty }"
                :disabled="!row.dirty || skuBusy"
                @click="saveSku(row)"
              >
                保存
              </button>
              <button class="wb-btn wb-btn--sm" type="button" :disabled="skuBusy" @click="deleteSku(row)">
                删
              </button>
            </div>

            <div v-if="dirtyCount" class="ed-sku__ops">
              <button class="wb-btn wb-btn--primary" type="button" :disabled="skuBusy" @click="saveAllDirty">
                保存全部改动（{{ dirtyCount }}）
              </button>
            </div>

            <span class="wb-field__hint">
              同款下「颜色+尺码」组合不可重复；编码非空时全局唯一。克重单位为克（与商品信息 Excel
              的物流重量同口径）。标「旧」的历史 SKU 只有名称，填上颜色尺码保存后即升级。
            </span>
          </template>
        </div>

        <p v-if="error" class="wb-notice wb-notice--error">{{ error }}</p>
      </div>

      <div class="wb-dialog__foot">
        <!-- 页脚那行小字把两个问题一次答完：**存了没有**（`savedHint`）与
             **关掉会丢什么**（`closeGuard`）。后者必须常显而不是只在点了 ✕ 之后才说 ——
             "还有 3 条 SKU 改动没保存"本身就是"别急着关"的提示。 -->
        <span v-if="savedHint" class="wb-muted ed-hint" data-act="ed-saved-hint">{{ savedHint }}</span>
        <span v-else-if="closeGuard" class="wb-muted ed-hint" data-act="ed-guard-hint">{{ closeGuard }}</span>
        <!-- ⚠️ 编辑模式**不再给「取消」**：改动已经边改边存，它已经没有可取消的东西了。
             再留一个「取消」，用户会以为那是"撤销我刚才的修改" —— 而它做不到（UX-G3）。
             新增模式仍是「取消 / 保存」：那时确实有一个还没创建的草稿可以取消。 -->
        <button v-if="!isEdit" class="wb-btn" type="button" :disabled="saving" @click="requestClose()">
          取消
        </button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          :disabled="saving || (!isEdit && !form.code.trim())"
          @click="isEdit ? complete() : save()"
        >
          {{ saving ? '保存中…' : isEdit ? '完成' : '保存' }}
        </button>
      </div>
    </aside>

    <!-- 关闭确认（W1）：只有"真的会丢"的两类才走到这里，见 `closeGuard` 的说明。 -->
    <ConfirmDialog
      v-if="confirmDiscard"
      title="关掉就会丢掉这些"
      confirm-text="放弃改动并关闭"
      @close="confirmDiscard = false"
      @confirm="discardAndClose"
    >
      <p>{{ closeGuard }} —— 关掉抽屉就没有了。</p>
      <p v-if="dirtyCount">先按那一行的「保存」或下面的「保存全部改动」，再关就不会丢。</p>
    </ConfirmDialog>
  </div>
</template>

<script setup lang="ts">
// 产品编辑抽屉。
//
// 为什么是**右侧抽屉**而不是居中弹窗：这一屏的内容是"表单 + 主图 + SKU 子表（可能几十行）"，
// 用户在改的同时经常要回头看列表里的其它款（对照编码、看还有哪些缺克重）。居中弹窗会把列表
// 整个盖住，抽屉只占右侧 560px，列表始终可见 —— 这是这一页刻意留的"记忆点"。
//
// ⭐ 保存模型（2026-10-08 R2 · UX-G3）：**统一为即时保存**。
//   旧模型是"一半一半"（主图 / SKU 即时存，表单要按底部「保存」），于是"填了名字直接点 ✕"
//   就是**没保存**，而「取消」不提示就关了 —— 真机走查实测：用户以为存了，其实没有。现在：
//     · 编辑模式：表单字段**离开输入框就写库**（`@blur` / `@change` → `autoSave`），
//       底部主按钮从「保存」改成「完成」（把还没落库的改动冲掉再关）；
//     · 关闭（✕ / 遮罩 / 完成）统一走 `requestClose()` —— 有**真的**会丢的东西时先确认（W1）；
//     · 新增模式没有 id 可写，"即时保存"无从谈起 ⇒ 保持显式「保存」（= 创建并关闭）。
//       这一处差异是**模式本身的性质**，不是"还有一半没改完"，所以它写在界面上（页首那句提示）
//       而不是假装统一。
//
// SKU 两条写入路径**仍是显式保存**，这不是漏改：一次生成几十行时逐行 blur 存会变成
// 几十次写 + 几十次重拉，而这屏最有辨识度的交互恰恰就是"一次生成几十个组合"。
// 代价（"改了没存就关"）由 `closeGuard` 兜住 —— **刻意不自动存的东西必须有别的兜底**。
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import * as api from '../api';
import { pickImage as selectImageFile } from '../productIo';
import ConfirmDialog from '@/core/components/ConfirmDialog.vue';
import { toast } from '@/core/services/toast';
import type { ProductListItem, VariantRow } from '@/types';

interface SupplierOption {
  id: number;
  name: string;
  productCount: number;
}

const props = defineProps<{
  /** null = 新增 */
  product: ProductListItem | null;
  suppliers: SupplierOption[];
}>();

const emit = defineEmits<{
  close: [];
  saved: [result: unknown, opts?: { keepOpen?: boolean }];
}>();

interface SkuRow {
  key: string;
  id: number;
  name: string;
  color: string;
  size: string;
  code: string;
  weightG: number | null;
  dirty: boolean;
}

const isEdit = computed(() => !!props.product?.id);
const saving = ref(false);
const error = ref('');

const form = reactive({
  id: props.product?.id ?? 0,
  code: props.product?.code ?? '',
  name: props.product?.name ?? '',
  supplierId: props.product?.supplierId ?? 0,
  category: props.product?.category ?? '',
  status: (props.product?.status === 'archived' ? 'archived' : 'active') as 'active' | 'archived',
  note: props.product?.note ?? '',
});

/* ---- 保存模型：快照 / 自动保存 / 关闭守卫（UX-G3 + W1）---- */

interface SaveOpts {
  /** 不关抽屉 —— 即时保存都带它（主图 / SKU / 字段自动保存同理） */
  keepOpen?: boolean;
  /** 不弹 toast，改在页脚显示一行小字（逐字段自动保存时每存一次弹一个 toast 会刷屏） */
  silent?: boolean;
}

/** 表单的**已落库快照**（字段与 `api.upsert` 的载荷同口径：文本 trim、id 归一为数字） */
function snapshot() {
  return {
    name: form.name.trim(),
    supplierId: Number(form.supplierId) || 0,
    category: form.category.trim(),
    status: form.status,
    note: form.note,
  };
}

const lastSaved = ref(snapshot());
const formDirty = computed(() => {
  const s = snapshot();
  const l = lastSaved.value;
  return (
    s.name !== l.name ||
    s.supplierId !== l.supplierId ||
    s.category !== l.category ||
    s.status !== l.status ||
    s.note !== l.note
  );
});

/** 正在飞的那条表单保存（同一条复用，不并发写同一行） */
let flying: Promise<boolean> | null = null;

const savedHint = ref('');
let hintTimer: ReturnType<typeof setTimeout> | null = null;
function flashSaved(text: string): void {
  savedHint.value = text;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    savedHint.value = '';
  }, 2500);
}

async function save(opts: SaveOpts = {}): Promise<boolean> {
  // 同一条表单保存**至多一条在飞**：`blur` 与「完成」可能在同一帧撞上，
  // 不串起来就会对同一行写两遍（第二遍的成功 toast 盖掉第一遍的失败）。
  if (flying) return flying;
  flying = doSave(opts).finally(() => {
    flying = null;
  });
  return flying;
}

async function doSave(opts: SaveOpts): Promise<boolean> {
  const code = form.code.trim();
  if (!code) {
    error.value = '款编码不能为空';
    return false;
  }
  saving.value = true;
  error.value = '';
  try {
    const r = await api.upsert({
      id: form.id || 0,
      code,
      name: form.name.trim(),
      supplierId: Number(form.supplierId) || 0,
      category: form.category.trim(),
      status: form.status,
      note: form.note,
    });
    // 快照跟着更新：`formDirty` 的判据是"与已落库的值比"，不是"按过按钮没有"
    lastSaved.value = snapshot();
    if (opts.silent) flashSaved('已自动保存');
    else toast(r?.created ? `已新增 ${code}` : `已更新 ${code}`, 'success');
    emit('saved', r, opts.keepOpen ? { keepOpen: true } : undefined);
    return true;
  } catch (e: unknown) {
    // 编码冲突这类错误必须留在表单里可见（toast 一闪而过，用户还要照着改）
    error.value = e instanceof Error ? e.message : String(e);
    if (opts.silent) toast(error.value, 'error');
    return false;
  } finally {
    saving.value = false;
  }
}

/**
 * 字段**离开即存**（编辑模式）。
 *
 * 判据是 `formDirty`（与已落库快照比），所以"点进来又原样离开"不会白白写一次库。
 * 新增模式直接返回：没有 id 可写（见文件头的保存模型说明）。
 */
async function autoSave(): Promise<void> {
  if (!isEdit.value || !formDirty.value) return;
  await save({ keepOpen: true, silent: true });
}

/**
 * 编辑模式的「完成」：把还没落库的表单改动冲掉，然后关。
 *
 * ⚠️ 必须先 `await flying`：点「完成」时输入框会先 blur（→ `autoSave` 已在飞），
 * 不等它落地就再发一条，两条写的是同一行。
 * ⚠️ 保存**失败就不关**：留在抽屉里让 `error` 可见 —— 关掉等于把"没存上"变成"存过了"。
 */
async function complete(): Promise<void> {
  if (flying) await flying;
  if (formDirty.value && !(await save({ keepOpen: true, silent: true }))) return;
  requestClose();
}

/**
 * 「关掉会丢的东西」—— 空串 = 可以放心关。
 *
 * ⚠️ 它**刻意不包含"表单有改动"**：编辑模式下那些改动是边改边存的。写进来的话就会变成一个
 * 每次关闭都弹、内容却已经不存在的确认框 —— 用户学两下就闭眼点过，真出事那次也照点。
 * 真正会丢的只有两类：
 *   · SKU 行 —— 刻意不自动存（见文件头），页面上有 `.ed-sku--dirty` 高亮与「保存全部改动」；
 *   · 新增模式的草稿 —— 还没有 id，一个字段都没写进库。
 */
const closeGuard = computed(() => {
  if (dirtyCount.value > 0) return `还有 ${dirtyCount.value} 条 SKU 改动没保存`;
  if (createTouched.value) return '这个新产品还没创建';
  return '';
});

/** 新增模式下**填过东西**（判据是"界面上有内容"，不是"有改动"——新增没有可比的基线） */
const createTouched = computed(
  () =>
    !isEdit.value &&
    ([form.code, form.name, form.category, form.note].some((v) => String(v).trim() !== '') ||
      (Number(form.supplierId) || 0) !== 0)
);

const confirmDiscard = ref(false);

/** 所有关闭路径的唯一出口（✕ / 点遮罩 / 保存成功后的收尾） */
function requestClose(): void {
  if (saving.value) {
    toast('还在保存，稍等一下再关', 'info');
    return;
  }
  if (closeGuard.value) {
    confirmDiscard.value = true;
    return;
  }
  emit('close');
}

function discardAndClose(): void {
  confirmDiscard.value = false;
  emit('close');
}

/* ---- 主图 ---- */

const imgUrl = ref('');
const imgBusy = ref(false);
const imagePath = ref(props.product?.imagePath ?? '');

async function loadThumb(): Promise<void> {
  imgUrl.value = '';
  if (!imagePath.value) return;
  try {
    const r = await api.imageThumbBatch([{ localPath: imagePath.value, maxEdge: 160 }]);
    imgUrl.value = r?.dataUrls?.[0] ?? '';
  } catch {
    // 缩略图失败不阻塞编辑（原图路径可能已失效），留空即可
    imgUrl.value = '';
  }
}

async function pickImage(): Promise<void> {
  if (imgBusy.value || !props.product) return;
  try {
    const srcPath = await selectImageFile();
    if (!srcPath) return; // 用户取消
    imgBusy.value = true;
    const r = await api.imageAttach(props.product.id, srcPath);
    imagePath.value = r.localPath;
    toast('主图已更新', 'success');
    await loadThumb();
    emit('saved', null, { keepOpen: true }); // 让列表刷新（不关抽屉）
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    imgBusy.value = false;
  }
}

async function removeImage(): Promise<void> {
  if (imgBusy.value || !props.product) return;
  imgBusy.value = true;
  try {
    await api.imageDetach(props.product.id);
    imagePath.value = '';
    imgUrl.value = '';
    toast('已移除主图', 'success');
    emit('saved', null, { keepOpen: true });
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    imgBusy.value = false;
  }
}

/* ---- SKU 子表 ---- */

const skuRows = ref<SkuRow[]>([]);
const skuLoading = ref(false);
const skuBusy = ref(false);
let skuKeySeq = 0;

/** 后端以 "颜色 尺码" 作组合键；此文案用于提示行标识 */
function composedName(row: SkuRow): string {
  return [row.color, row.size]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ');
}

/** 历史 SKU：有 id、无颜色尺码、只有自由文本名称 */
function isLegacy(row: SkuRow): boolean {
  return !!row.id && !String(row.color || '').trim() && !String(row.size || '').trim() && !!row.name;
}

/** 行级校验：颜色尺码要么成对、要么都不填（老数据仅名称） */
function rowError(row: SkuRow): string {
  const c = String(row.color || '').trim();
  const s = String(row.size || '').trim();
  if (!c !== !s) return '颜色和尺码要成对填写';
  if (!c && !s && !String(row.name || '').trim()) return '请填写颜色和尺码';
  return '';
}

async function loadSkus(): Promise<void> {
  if (!isEdit.value || !props.product) return;
  skuLoading.value = true;
  try {
    const r = await api.variantList([props.product.id]);
    skuRows.value = (r?.rows ?? []).map((v: VariantRow) => ({
      key: `v${v.id}`,
      id: v.id,
      name: v.name,
      color: v.color || '',
      size: v.size || '',
      code: v.code,
      weightG: v.weightG || null,
      dirty: false,
    }));
  } catch (e: unknown) {
    toast(`SKU 读取失败：${e instanceof Error ? e.message : e}`, 'error');
  } finally {
    skuLoading.value = false;
  }
}

/** 单行提交载荷（全量：缺字段会被清空） */
function skuPayload(row: SkuRow) {
  return {
    id: row.id,
    productId: props.product?.id ?? 0,
    name: composedName(row) || String(row.name || '').trim(),
    color: String(row.color || '').trim(),
    size: String(row.size || '').trim(),
    code: String(row.code || '').trim(),
    weightG: Math.max(0, Math.round(Number(row.weightG) || 0)),
    status: 'active' as const,
  };
}

async function saveSku(row: SkuRow): Promise<void> {
  if (skuBusy.value) return;
  const err = rowError(row);
  if (err) {
    toast(err, 'error');
    return;
  }
  skuBusy.value = true;
  try {
    await api.variantUpsert(skuPayload(row));
    row.dirty = false;
    toast('SKU 已保存', 'success');
    await loadSkus(); // 回填 id / 排序
    emit('saved', null, { keepOpen: true });
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    skuBusy.value = false;
  }
}

const dirtyCount = computed(() => skuRows.value.filter((r) => r.dirty).length);

/** 批量保存所有改动行（**先整体校验再逐条提交** —— 别存一半留一半脏的） */
async function saveAllDirty(): Promise<void> {
  const dirty = skuRows.value.filter((r) => r.dirty);
  if (!dirty.length || skuBusy.value) return;
  for (const r of dirty) {
    const err = rowError(r);
    if (err) {
      toast(`「${composedName(r) || r.name || '未命名'}」${err}`, 'error');
      return;
    }
  }
  skuBusy.value = true;
  try {
    for (const r of dirty) await api.variantUpsert(skuPayload(r));
    toast(`已保存 ${dirty.length} 条 SKU`, 'success');
    await loadSkus();
    emit('saved', null, { keepOpen: true });
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
    await loadSkus(); // 部分成功后对齐服务端状态
  } finally {
    skuBusy.value = false;
  }
}

/* ---- 批量生成（颜色列表 × 尺码拖选）---- */

const SIZE_LETTER = ['S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'];
const SIZE_HEIGHT = ['150', '155', '160', '165', '170', '175', '180', '185', '190'];
const genColor = ref('');
const genColors = ref<string[]>([]);
const genSize = ref('');
const customSizes = ref<string[]>([]);
const selSizes = ref<Record<string, boolean>>({});
const genWeight = ref<number | null>(null);

const sizeGroups = computed(() => {
  const groups = [
    { name: '字母码', items: SIZE_LETTER },
    { name: '身高码', items: SIZE_HEIGHT },
  ];
  if (customSizes.value.length) groups.push({ name: '自定义', items: [...customSizes.value] });
  return groups;
});

const selCount = computed(() => Object.values(selSizes.value).filter(Boolean).length);

function addGenColor(): void {
  const parts = String(genColor.value)
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (!genColors.value.includes(p)) genColors.value.push(p);
  }
  genColor.value = '';
}

function flushGenColor(): void {
  if (genColor.value.trim()) addGenColor();
}

function removeGenColor(i: number): void {
  genColors.value.splice(i, 1);
}

function addGenSize(): void {
  const s = genSize.value.trim();
  if (!s) return;
  const known = [...SIZE_LETTER, ...SIZE_HEIGHT, ...customSizes.value];
  if (!known.includes(s)) customSizes.value.push(s);
  selSizes.value[s] = true;
  genSize.value = '';
}

// 拖选：mousedown 定方向（选中=继续加，取消=继续减），mouseenter 沿途生效，mouseup 收尾
const dragMode = ref<'add' | 'remove' | null>(null);

function sizePress(s: string): void {
  const next = !selSizes.value[s];
  selSizes.value[s] = next;
  dragMode.value = next ? 'add' : 'remove';
}

function sizeEnter(s: string): void {
  if (!dragMode.value) return;
  selSizes.value[s] = dragMode.value === 'add';
}

function sizeLeave(): void {
  dragMode.value = null;
}

/**
 * 键盘切换单个尺码（报告 P2-2 的"键盘可达"）。
 *
 * ⚠️ 刻意**不复用** `sizePress`：那个顺手把 `dragMode` 设成 add/remove，而键盘没有
 * "mouseup" 来收尾 —— 残留的 dragMode 会让**下一次鼠标划过的那个码**被莫名其妙地改动
 * （拖动连选本来是加速器，留个脏状态就变成了 bug）。键盘只做"切换这一个"。
 */
function sizeToggle(s: string): void {
  selSizes.value[s] = !selSizes.value[s];
  dragMode.value = null;
}

/** 整组全选 / 清空。只碰这一组里的码，不动别组与自定义码。 */
function setGroupAll(items: readonly string[], on: boolean): void {
  for (const s of items) selSizes.value[s] = on;
  dragMode.value = null;
}

function generate(): void {
  const sizes = Object.keys(selSizes.value).filter((k) => selSizes.value[k]);
  if (!genColors.value.length || !sizes.length) return;
  const existing = new Set(
    skuRows.value.map((r) => `${String(r.color || '').trim()}|${String(r.size || '').trim()}`)
  );
  let added = 0;
  for (const c of genColors.value) {
    for (const s of sizes) {
      if (existing.has(`${c}|${s}`)) continue;
      existing.add(`${c}|${s}`);
      skuRows.value.push({
        key: `n${skuKeySeq++}`,
        id: 0,
        name: '',
        color: c,
        size: s,
        code: '',
        weightG: genWeight.value ?? null,
        dirty: true,
      });
      added += 1;
    }
  }
  toast(
    added ? `已生成 ${added} 个组合（改好克重后点「保存全部改动」）` : '没有新增组合 —— 全部已存在',
    added ? 'success' : 'info'
  );
}

async function deleteSku(row: SkuRow): Promise<void> {
  if (!row.id) {
    // 未落库的生成行：本地移除即可
    skuRows.value = skuRows.value.filter((r) => r.key !== row.key);
    return;
  }
  if (skuBusy.value) return;
  skuBusy.value = true;
  try {
    await api.variantDelete(row.id);
    toast(`已删除「${composedName(row) || row.name}」`, 'success');
    await loadSkus();
    emit('saved', null, { keepOpen: true });
  } catch (e: unknown) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    skuBusy.value = false;
  }
}

onMounted(() => {
  // 拖选在芯片外松开鼠标时也要收尾（芯片自身的 mouseup 接不到）
  window.addEventListener('mouseup', sizeLeave);
  void loadThumb();
  void loadSkus();
});

onUnmounted(() => {
  window.removeEventListener('mouseup', sizeLeave);
  if (hintTimer) clearTimeout(hintTimer);
});
</script>

<style scoped>
/* 遮罩只做"点击空白关闭"，抽屉自己贴在右侧（两者都在全局 .wb-mask / .wb-drawer 里） */
.ed-mask {
  align-items: stretch;
  justify-content: flex-end;
  padding: 0;
}

.ed-head {
  justify-content: flex-start;
}
.ed-head__code {
  font-size: 12px;
  font-weight: 400;
}
.ed-x {
  margin-left: auto;
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 14px;
  line-height: 1;
  color: var(--wb-text-muted);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--wb-radius-sm);
}
.ed-x:hover {
  background: var(--wb-hover);
  color: var(--wb-text);
}

/* 页脚那行小字（`已自动保存` / `还有 N 条 SKU 改动没保存`）靠左，
   两个按钮保持右对齐 —— 与产品选择器 `ProductPicker` 同一条排法。 */
.ed-hint {
  margin-right: auto;
  font-size: 12px;
  white-space: normal;
}

.ed-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ed-row {
  display: flex;
  gap: 12px;
}
.ed-row > * {
  flex: 1;
  min-width: 0;
}

.is-readonly {
  background: var(--wb-hover);
  color: var(--wb-text-muted);
}

/* ---- 主图 ---- */
.ed-img {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ed-img__pic {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-hover);
}
.ed-img__empty {
  width: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--wb-border);
  border-radius: var(--wb-radius-md);
  color: var(--wb-text-muted);
  font-size: 11px;
}
.ed-img__ops {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ---- SKU 批量生成区 ---- */
.ed-skus {
  gap: 8px;
}
.ed-gen {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px dashed var(--wb-border-strong);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}
.ed-gen__label {
  font-size: 12px;
  color: var(--wb-text-muted);
}
.ed-gen__line {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ed-gen__size {
  flex: 1;
  min-width: 0;
}
.ed-gen__weight {
  flex: 0 0 120px;
  min-width: 0;
}

.ed-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.ed-chips__name {
  flex: 0 0 44px;
  font-size: 11px;
  color: var(--wb-text-muted);
}
/* 「全选本组 / 清空本组」：一组里的**批动作**，与一个个码区分开 ——
   推到该组末尾并压小一号。
   ⚠️ 不能用 `:first-of-type`：组里那些尺码码也是 `<button>`，`:first-of-type` 命中的
   是**第一个尺码**（不是第一个批动作按钮），于是「全选本组」会被推到第二行去。
   按 `data-act` 选就没有这个歧义。 */
.ed-chips__bulk {
  font-size: 11px;
}
.ed-chips__bulk[data-act='size-all'] {
  margin-left: auto;
}
.ed-chip {
  padding: 2px 8px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  border: 1px solid var(--wb-border-strong);
  border-radius: 999px;
  background: var(--wb-surface);
  color: var(--wb-text);
  cursor: pointer;
  user-select: none;
}
.ed-chip:hover {
  border-color: var(--wb-primary);
}
.ed-chip--color {
  border-style: dashed;
}
.ed-chip--size.ed-chip--on {
  background: var(--wb-primary);
  border-color: var(--wb-primary);
  color: var(--wb-primary-contrast);
}
.ed-chip--size.ed-chip--on:hover {
  background: var(--wb-primary-hover);
}

/* ---- SKU 行 ---- */
.ed-sku {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: var(--wb-radius-sm);
}
.ed-sku--dirty {
  background: var(--wb-primary-soft);
  box-shadow: inset 2px 0 0 var(--wb-primary);
}
.ed-tag {
  flex-shrink: 0;
  padding: 0 4px;
  font-size: 11px;
  color: var(--wb-text-muted);
  border: 1px solid var(--wb-border-strong);
  border-radius: var(--wb-radius-sm);
  cursor: help;
}
.ed-sku__color {
  flex: 1 1 20%;
  min-width: 0;
}
.ed-sku__size {
  flex: 1 1 16%;
  min-width: 0;
}
.ed-sku__code {
  flex: 1 1 20%;
  min-width: 0;
}
.ed-sku__weight {
  flex: 0 0 88px;
  min-width: 0;
}
.ed-sku__ops {
  display: flex;
  justify-content: flex-end;
}
</style>
