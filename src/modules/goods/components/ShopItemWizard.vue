<template>
  <div class="wb-mask" @click.self="emit('close')">
    <aside class="wb-drawer iw-drawer" role="dialog" aria-modal="true" aria-label="新建款并关联">
      <div class="wb-dialog__head">
        <span>新建款并关联</span>
        <span class="wb-mono wb-muted iw-head__item">{{ item.itemId }}</span>
        <button class="iw-x" type="button" aria-label="关闭" data-act="iw-close" @click="emit('close')">✕</button>
      </div>

      <div class="wb-dialog__body iw-body">
        <!-- ── 档案（预填自采集，保存由人点）──────────────────────────── -->
        <section class="iw-block">
          <h4 class="iw-block__title">档案</h4>
          <label class="wb-field">
            <span class="wb-field__label">款编码</span>
            <input class="wb-input is-readonly" :value="nextCode" readonly data-act="iw-code" />
            <span class="wb-field__hint">
              系统发号（识别建款与手工建档共用同一个序号池，不会撞号）。一经创建不可改 ——
              编码是订单 / 采购 / 成本三域的关联锚点。
            </span>
          </label>
          <label class="wb-field">
            <span class="wb-field__label">款式名 <i class="wb-field__req">*</i></span>
            <input v-model="form.name" class="wb-input" placeholder="例：折叠收纳箱 60L" data-act="iw-name" />
            <span class="wb-field__hint">预填自采集标题，可改。</span>
          </label>
          <label class="wb-field">
            <span class="wb-field__label">类目</span>
            <input v-model="form.category" class="wb-input" placeholder="例：家居收纳" data-act="iw-category" />
          </label>
          <label class="wb-field">
            <span class="wb-field__label">供应商 <i class="wb-field__req">*</i></span>
            <select v-model="form.supplierId" class="wb-input" data-act="iw-supplier">
              <option :value="0">— 请选择 —</option>
              <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
            <span v-if="!suppliers.length" class="wb-field__hint">
              还没有供应商 —— 到「供应商」页建一个再来（建档必须知道找谁拿货）。
            </span>
          </label>
          <!-- 采纳为款主图（方案 P4）：默认勾选 = 新建档的款不可能已有主图；
               只补空的判定在主进程（款已有主图时不覆盖），下载失败也不阻断款与商品。 -->
          <label v-if="item.imageUrl" class="iw-adopt">
            <input v-model="form.adoptImage" type="checkbox" data-act="iw-adopt-image" />
            <span class="iw-adopt__label">采纳为款主图</span>
            <span class="wb-field__hint">
              把采集主图设为这一款的主图（只补空：不会覆盖已有主图）。下载失败不影响款与商品，回执会说明。
            </span>
          </label>
          <p v-else class="wb-field__hint">这一行没有采集到主图，跳过「采纳为款主图」。</p>
        </section>

        <!-- ── SKU 矩阵（规格区：色 / 码 / 默认克重；组合区：格 = 在不在卖 + 克重）──── -->
        <section class="iw-block">
          <h4 class="iw-block__title">
            SKU 矩阵 <span class="wb-muted iw-block__sub">（色 × 码；克重人补，可批量填）</span>
          </h4>
          <p class="wb-field__hint">
            预填自商品详情页的采集（含快照里人补过的克重）。颜色认不出标准色名时<b>保留原文并高亮</b>
            （可能是平台数字色号）—— 请对照色图确认或改成标准色名（点色图可看大图）；
            色号是店铺自己的编码，绝不自动猜「4 → 某色」。
          </p>
          <SkuMatrixEditor
            v-model="matrix"
            class="iw-sku"
            act="iw-sku"
            :fallback-image-url="item.imageUrl"
            :disabled="busy"
            empty-hint="这个商品还没采到 SKU 矩阵（列表页轻采不带；在商品详情页点「采 SKU」后重开本向导即有）。也可以先只建档案，SKU 之后到产品编辑里补。"
          />
          <p v-if="flaggedCount" class="iw-flag-note" data-act="iw-flag-note">
            <b>{{ flaggedCount }}</b> 行颜色认不出标准色名（高亮行）—— 对照缩略图确认，或直接改成标准色名。
          </p>
        </section>
      </div>

      <!-- ── 底部：一次点击做三件既有事 ───────────────────────────────
           ⚠️ 这一段必须在 `.wb-dialog__body` **外面**（是抽屉的第三段，不是 body 的一部分）。
           放在 body 里时它跟着内容一起滚：档案 + 矩阵把内容顶到两屏高，"建档并关联"
           首屏根本不在视野里 —— 用户看到的就是"这页没法操作"。
           常驻底部的动作条是这个抽屉唯一的出口，它不能藏。 -->
      <div class="wb-dialog__foot iw-foot">
        <div class="iw-foot__msg">
          <p v-if="error" class="wb-notice wb-notice--error" data-act="iw-error">{{ error }}</p>
          <div v-else-if="receipt" class="iw-receipt" data-act="iw-receipt">
            已建档 <b class="wb-mono">{{ receipt.productCode }}</b
            ><span class="wb-muted">（#{{ receipt.productId }}）</span> · 写入 SKU
            <b>{{ receipt.variantsWritten }}</b> 条<span v-if="receipt.variantsFailed">，{{ receipt.variantsFailed }} 条失败</span> ·
            {{ receipt.related ? '已关联到本商品' : '关联未完成（可重试）' }}
            <span v-if="receipt.mainImage === 'adopted'" data-act="iw-receipt-img"> · 主图已采纳</span>
            <span v-else-if="receipt.mainImage === 'failed'" class="iw-receipt__warn" data-act="iw-receipt-img-fail">
              · 主图没设上（{{ receipt.mainImageError || '下载失败' }}）
            </span>
            <span v-if="receipt.colorImages.bound"> · 色图绑定 <b>{{ receipt.colorImages.bound }}</b> 张</span>
            <span v-if="receipt.colorImages.skipped" class="wb-muted">
              · 色图跳过 {{ receipt.colorImages.skipped }} 张（该色已有图，不覆盖）
            </span>
            <span v-if="receipt.colorImages.failed" class="iw-receipt__warn"> · 色图失败 {{ receipt.colorImages.failed }} 张</span>
          </div>
          <p v-else class="iw-foot__hint">
            一次点击依次做三件既有事：建档 → 写 SKU → 认到新款。之后导入的订单会自动归类到这一款。
          </p>
        </div>
        <div class="iw-foot__acts">
          <button class="wb-btn" type="button" :disabled="busy" @click="emit('close')">
            {{ receipt ? '完成' : '取消' }}
          </button>
          <button
            class="wb-btn wb-btn--primary"
            type="button"
            data-act="iw-save"
            :disabled="busy || !canSave"
            @click="save"
          >
            {{ busy ? '建档中…' : '建档并关联' }}
          </button>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import * as api from '../api';
import type { ShopItemRow, Supplier } from '@/types';
import SkuMatrixEditor from './SkuMatrixEditor.vue';
import {
  emptySkuMatrix,
  fromSkuMatrix,
  isUnknownColorName,
  parseSkuJsonRows,
  toSkuMatrix,
  type SkuMatrix,
} from '@/lib/skuMatrix';

/**
 * 建款向导（从采集商品新建款并关联；方案 §4.3）。
 *
 * 为什么不扩 `ProductEditorDrawer`：那个抽屉是**失焦即存**模型（档案字段 @blur → autoSave），
 * 而本向导要的是"预填 → 人逐行确认 → 一次点击三连写"。两种保存模型塞进一个组件，
 * 「现在到底存了没有」这件事就没法一句话说清。向导只做组织者：三个写入全部走既有 IPC。
 */

const props = defineProps<{
  item: ShopItemRow;
  busy: boolean;
  error: string;
  receipt: {
    productId: number;
    productCode: string;
    variantsWritten: number;
    variantsFailed: number;
    related: boolean;
    /** 主图采纳结果：'adopted' 已采纳 / 'skipped' 没勾选或没图 / 'failed' 下载失败。
     *  （没有 'reused' 态：向导只建新档、新档必然没有主图 ⇒ 采纳要么成要么失败；
     *   "采集行早有本地图"是下载层面的复用事实，不进回执。） */
    mainImage: 'adopted' | 'skipped' | 'failed';
    mainImageError: string;
    /** 色图采纳统计（bound = 绑到款色上的张数；其余说清为什么没绑） */
    colorImages: { bound: number; skipped: number; failed: number };
  } | null;
}>();
const emit = defineEmits<{
  close: [];
  save: [
    payload: {
      code: string;
      name: string;
      category: string;
      supplierId: number;
      /** 采纳采集主图为款主图（只补空；没图时向导不给这个勾选） */
      adoptImage: boolean;
      skus: { color: string; size: string; weightG: number; imageUrl: string }[];
    },
  ];
}>();

const form = ref({ name: '', category: '', supplierId: 0, adoptImage: true });
/**
 * SKU 矩阵（色 × 码）。用 `SkuMatrixEditor` 与产品编辑抽屉**同一个组件** ——
 * 两处的差异只在 props：这里格子里填克重（建档时唯一必须人补的），行头图回落商品主图。
 */
const matrix = ref<SkuMatrix>(emptySkuMatrix());
const suppliers = ref<Supplier[]>([]);
const nextCode = ref('');

/**
 * 「认不出」计数（高亮由矩阵组件自己按同一个判据画）。
 * 判据 = `isUnknownColorName`（归一结果仍等于原文）—— 数字色号（`4`）与平台英文色名
 * （`Black`，词表是中文的）都落在这里，都该由人看着图确认。
 */
const flaggedCount = computed(() => matrix.value.rows.filter((r) => isUnknownColorName(r.color)).length);

/** 保存闸：款式名 + 供应商（色号高亮**不拦保存** —— 那是促确认，不是校验） */
const canSave = computed(() => !!form.value.name.trim() && form.value.supplierId > 0);

onMounted(async () => {
  // 预填全部来自采集事实（标题 / 类目 / SKU 矩阵）—— 默认值只能来自证据
  form.value.name = props.item.title || '';
  form.value.category = props.item.category || '';
  // 新建档的款不可能已有主图 ⇒ 有采集图时默认勾选（只补空的兜底判定仍在主进程）
  form.value.adoptImage = !!props.item.imageUrl;
  // 快照里的克重（人之前在「改 SKU 矩阵」里补的）也预填进来 —— 同一份事实，不再让人重填一遍
  const flat = parseSkuJsonRows(props.item.skuJson);
  matrix.value = flat.length ? toSkuMatrix(flat) : emptySkuMatrix();
  try {
    const [sups, code] = await Promise.all([api.supplierList(), api.nextCode()]);
    suppliers.value = sups;
    nextCode.value = code.code;
  } catch {
    // 供应商 / 发号失败不阻塞打开：保存时闸门与报错会把缺的说清（编码空 = 保存即报错）
  }
});

function save(): void {
  emit('save', {
    code: nextCode.value,
    name: form.value.name,
    category: form.value.category,
    supplierId: form.value.supplierId,
    adoptImage: form.value.adoptImage && !!props.item.imageUrl,
    // 展开只输出**存在的格**（空格 = 这个组合不存在）—— 凭空补格等于造出不存在的 SKU。
    skus: fromSkuMatrix(matrix.value).map((r) => ({
      color: r.color,
      size: r.size,
      weightG: Math.max(0, Math.round(Number(r.weightG) || 0)),
      // 色图用**人确认后的色名**（用户可能把数字色号改成标准色名）——
      // 采纳绑的款色必须与写进 pl_variants 的色是同一个，订单归色才认得上。
      imageUrl: r.imageUrl,
    })),
  });
}
</script>

<style scoped>
.iw-drawer {
  width: 640px;
}
.iw-head__item {
  font-size: 12px;
  font-weight: 400;
}
.iw-x {
  margin-left: auto;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--wb-text-muted);
  padding: 2px 6px;
}
.iw-x:hover {
  color: var(--wb-text);
}
.iw-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.iw-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.iw-block__title {
  margin: 0;
  font-size: 13px;
  color: var(--wb-text);
}
.iw-block__sub {
  font-size: 12px;
  font-weight: 400;
}
/* 只读格要长得和可编辑格不一样（纯文本感，不是 disabled 输入框）—— 与产品编辑同一结论 */
.iw-body .wb-input.is-readonly {
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  cursor: default;
}
/* 「采纳为款主图」勾选：复选框 + 一行说明（默认勾选的理由写在 hint 里） */
.iw-adopt {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.iw-adopt input {
  margin: 0;
}
.iw-adopt__label {
  font-size: 13px;
  color: var(--wb-text);
}
.iw-adopt .wb-field__hint {
  flex-basis: 100%;
}
/* 回执里的图片失败段：不用红色警告条（建档已成功，这是附带信息），只换文字色 */
.iw-receipt__warn {
  color: var(--wb-warning);
}
/* SKU 矩阵的样式（列宽 / 空格语义 / 认不出色名的高亮）都在 `SkuMatrixEditor.vue` 里 ——
   ⚠️ 父组件的 scoped 样式**打不到**子组件渲染出来的 td（scope 属性不在那些元素上），
   所以这里**不要**再写 `.iw-sku tr...` 这类选择器（写了是死样式）。 */
.iw-flag-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}
.iw-foot {
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}
.iw-foot__msg {
  min-height: 20px;
}
.iw-foot__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-text-muted);
}
.iw-receipt {
  font-size: 13px;
  line-height: 1.6;
  color: var(--wb-text);
}
.iw-foot__acts {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
