<template>
  <!-- 对比认款（方案 §2.2 动线 C）：把「候选产品」与「店铺商品」并排摆到一屏，看清了再按空格。
       遮罩点击 = 关闭（点空白处想退出是本能，强迫人去找关闭键没必要）。 -->
  <div class="wb-mask" data-act="compare-modal" @click.self="$emit('close')">
    <div class="wb-dialog gd-cmp" role="dialog" aria-modal="true" aria-label="对比认款">
      <div class="wb-dialog__head">
        <span>对比认款</span>
        <span class="wb-muted gd-cmp__count">{{ products.length ? idx + 1 : 0 }} / {{ products.length }}</span>
      </div>

      <div class="wb-dialog__body gd-cmp__body">
        <figure class="gd-cmp__side" data-act="compare-side-left">
          <figcaption>
            <span class="wb-muted">候选产品</span>
            <b class="wb-mono">{{ cur?.code || '—' }}</b>
            <span class="gd-cmp__name">{{ cur?.name || '' }}</span>
          </figcaption>
          <img
            v-if="leftSrc"
            :src="leftSrc"
            class="gd-cmp__img"
            data-act="compare-product-img"
            alt=""
          />
          <!-- 没图说得出来是**哪一边**没图：这一句讲的是候选款没主图（换个候选就行），
               与下面那句"订单里没有这件的图"是两回事，混成一句用户就不知道该怎么办了。 -->
          <p v-else class="gd-cmp__empty" data-act="compare-product-empty">
            {{ loading ? '读取中…' : '这一款没有主图 —— 按 → 换下一款' }}
          </p>
        </figure>

        <figure class="gd-cmp__side" data-act="compare-side-right">
          <figcaption>
            <span class="wb-muted">店铺商品</span>
            <b class="wb-mono">{{ item.itemId }}</b>
            <span class="gd-cmp__name wb-muted">{{ item.shopName || item.shopRaw }}</span>
          </figcaption>
          <img
            v-if="itemImage"
            :src="itemImage.dataUrl"
            class="gd-cmp__img"
            data-act="compare-item-img"
            :title="itemImage.source"
            alt=""
          />
          <p v-else class="gd-cmp__empty" data-act="compare-item-empty">
            订单里没有这件的图 —— 换个角度只能去原始订单里看
          </p>
        </figure>
      </div>

      <div class="wb-dialog__foot gd-cmp__foot">
        <button class="wb-btn" type="button" data-act="compare-prev" :disabled="products.length < 2" @click="prev">
          ← 上一款
        </button>
        <button class="wb-btn" type="button" data-act="compare-next" :disabled="products.length < 2" @click="next">
          下一款 →
        </button>
        <span class="wb-muted gd-cmp__tip">← / → 换候选 · 空格 关联 · Esc 关闭</span>
        <button class="wb-btn" type="button" data-act="compare-close" @click="$emit('close')">关闭</button>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="compare-confirm"
          :disabled="!cur || loading"
          @click="confirm"
        >
          关联到 {{ cur?.code || '这款' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 对比认款（方案 §2.2 动线 C）。
//
// 为什么需要它：队列行的图来自订单（这件在订单里的样子），而"这是不是那款"只有把两边的图
// **摆在一起**才判断得了 —— 40px 缩略图 + 表格式排布时，人是在两个屏幕之间用记忆比。分栏只
// 解决了"款与商品同屏"，没解决"图与图同屏"。
//
// ⚠️ 候选产品的图必须**独立取**（产品主图 `imagePath` → 缩略图垫场 → 原图），
// 绝不能走 `itemImagePool`：队列是"还没配映射"的那一半，图池的第 ③ 层（款主图）对它必然是
// 空的 —— 拿图池的"产品层"当候选图会得到一片空白，而且**不报错**（方案 §8-3 变异 5 钉的就是这条）。
//
// 本组件**不写库**：只回传"选中了哪一款"，写映射仍由 `useSkuPool.commitMap` 一处负责
// （与 `ProductPicker` 同一分工：弹层只管"选谁"）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import * as api from '../api';
import type { ProductListItem, SkuQueueRow } from '@/types';

const props = withDefaults(
  defineProps<{
    item: SkuQueueRow;
    /** 该商品在订单里的图（与队列那一列同源）。没图时右侧说明"去哪看"，不显示破图 */
    itemImage: { dataUrl: string; source: string } | null;
    /** 左栏「当前款」的 id：有它就从这一款开始翻（多半就是它）；0 = 从第一行开始 */
    initialProductId?: number;
  }>(),
  { initialProductId: 0 }
);

const emit = defineEmits<{ close: []; confirm: [productId: number] }>();

/** 候选条数上限：与产品选择弹层同量级（`productList` 上限 500，这里再收一档，免得弹层里塞整库） */
const CAND_LIMIT = 200;

const products = ref<ProductListItem[]>([]);
const idx = ref(0);
const loading = ref(false);
/** 左侧候选图（先缩略图垫场、再换原图） */
const leftSrc = ref('');
const cur = computed(() => products.value[idx.value] ?? null);

/** 取图请求序号：连着翻页时，先前那次的异步结果必须丢弃（否则图会盖到错的候选上） */
let imgSeq = 0;

async function loadLeft(): Promise<void> {
  const p = cur.value;
  const seq = ++imgSeq;
  leftSrc.value = '';
  if (!p?.imagePath) return;
  // 先拿缩略图顶上（不让用户对着空白等 IPC），拿到原图再替换 —— 与队列"点开看大图"同一手法。
  // 认款要看印花 / 领型，最终得是原图；但取原图失败时留在缩略图上，而不是什么都不显示。
  try {
    const t = await api.imageThumbBatch([{ localPath: p.imagePath }]);
    if (seq === imgSeq && t?.dataUrls?.[0]) leftSrc.value = t.dataUrls[0];
  } catch {
    // 缩略图失败不影响下面再试原图
  }
  try {
    const big = await api.readImage(p.imagePath);
    if (seq === imgSeq && big?.dataUrl) leftSrc.value = big.dataUrl;
  } catch {
    // 保留缩略图
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await api.list({ offset: 0, limit: CAND_LIMIT, search: '', status: 'active', supplierId: 0 });
    products.value = res?.rows ?? [];
    const i = products.value.findIndex((p) => p.id === props.initialProductId);
    idx.value = i >= 0 ? i : 0;
  } catch {
    // 候选拉不到不该把弹层变成一个错误红条：空列表 + 关闭即可
    products.value = [];
  } finally {
    loading.value = false;
  }
  await loadLeft();
}

function next(): void {
  if (products.value.length < 2) return;
  idx.value = (idx.value + 1) % products.value.length;
  void loadLeft();
}
function prev(): void {
  if (products.value.length < 2) return;
  idx.value = (idx.value - 1 + products.value.length) % products.value.length;
  void loadLeft();
}

function confirm(): void {
  const p = cur.value;
  if (p) emit('confirm', p.id);
}

/**
 * 键盘：`←` / `→` 换候选、`空格` 确认、`Esc` 关闭。
 *
 * 挂在 `window` 上而不是弹层元素上：弹层里没有任何输入框，用户的手不会先"点进来"再按键，
 * 挂元素上就得先聚焦一次 —— 等于键盘快捷方式在最需要它的那一刻不生效。
 * ⚠️ 一律 `preventDefault`：空格 / 方向键默认会滚动页面，弹层背后那一页会跟着晃。
 */
function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    prev();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    next();
  } else if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    confirm();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  await load();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped>
.gd-cmp {
  width: min(94vw, 1180px);
  max-width: min(94vw, 1180px);
}
.gd-cmp__count {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
}

/* 两栏并排：这才是"对比"本身 —— 上下排就不是对比了（眼睛要来回跳）。 */
.gd-cmp__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  align-items: stretch;
}
@media (max-width: 820px) {
  .gd-cmp__body {
    grid-template-columns: minmax(0, 1fr);
  }
}
.gd-cmp__side {
  margin: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.gd-cmp__side figcaption {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
}
.gd-cmp__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gd-cmp__img {
  width: 100%;
  height: 52vh;
  object-fit: contain;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}
.gd-cmp__empty {
  margin: 0;
  height: 52vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
  text-align: center;
  border: 1px dashed var(--wb-border);
  border-radius: var(--wb-radius-md);
  font-size: 13px;
  color: var(--wb-text-muted);
}

.gd-cmp__foot {
  flex-wrap: wrap;
  gap: 8px;
}
/* 键盘提示推到右半边（它是一句说明，不是按钮），别夹在两个按钮中间 */
.gd-cmp__tip {
  margin-left: auto;
  font-size: 12px;
}
</style>
