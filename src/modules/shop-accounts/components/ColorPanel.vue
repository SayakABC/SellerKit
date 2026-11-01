<script setup lang="ts">
// 「基础数据 › 产品管理 › 颜色」—— 颜色板与合并（2026-10-30 用户口径：
// 「当前颜色的管理页面还没有，现状是存在相同的颜色，只是名称不一样，要支持颜色合并」）。
//
// ── 2026-10-30 重新设计（用户反馈两点）───────────────────────────────────
//   ① 颜色太多时拖动定位麻烦；② 数字色号 / 平台原文色名没有真实色块，不知道该并给谁。
//   解法：把板拆成上下两区 ——
//     · **标准色**（字典里的色，合并目标）：用**色卡**展示，色块 = 真实 hex（可点取色器改）。
//       色卡是大目标，合并靠「点一下待归一行 → 点一下标准色卡」，不再靠拖小行。
//     · **待归一色名**（数字色号 / 平台原文 / 未入字典的异写）：列表，每行只带用量与徽标，
//       没有色块（"还没认出来"就是没色块，不给中性灰兜底假装是答案）。
//   合并手势：点待归一行选中 → 点任一标准色卡即合并（选中态提示挂在回执行，不占额外高度）。
//   拖拽保留为**快捷**方式（拖待归一行到标准色卡），但不再是唯一路径。
//
// ── 2026-10-31 用户三点反馈（本版）────────────────────────────────────────
//   ① 标准色卡太大、区里还出一条滚动条 —— 卡片压成两行小卡（色块 20px），容器不再自己滚，
//      标准色一屏全部露出；腾出来的高度留给下面的待归一名单（名单仍按需滚动）。
//   ② 待归一名单没有图，「数字色号」根本不知道是什么颜色 —— 每行加一张**款图**
//      （`ColorBoardItem.imagePath`，主进程从 `oi_style_colors.image_id` → `md_images` 解析），
//      经 `orderImageThumbBatch` 取缩略图；没图的色画空占位（不拿灰块假装是答案）。
//   ③ 「色名」列占 46% 太宽 —— 收成内容宽（`width: 1%` + nowrap），余宽让给用量。
//
// ── 合并必须真正改数据 ────────────────────────────────────────────────
// 主进程 `md-color-merge` 会把款色 / SKU / 别名全部改指保留色（不是只记一条别名），
// 因此本页合并完要**重拉颜色板 + 刷新字典单例**（两个页面共享同一份字典，见 `colorDict.ts`）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  mdColorBoard,
  mdColorMerge,
  mdColorUpdateHex,
  orderImageThumbBatch,
} from '@/core/services/ipc';
import { addColorToDict, colorSwatchOf, loadColorDict } from '@/core/services/colorDict';
import type { ColorBoardItem, ColorMergeOutcome } from '@/types';

const rows = ref<ColorBoardItem[]>([]);
const loading = ref(true);
const loadError = ref('');
const merging = ref(false);
const adding = ref(false);
const updatingHex = ref<number | null>(null);

const query = ref('');
const newColor = ref('');
/** 新增标准色时取色器选的 hex（空串 = 用内置词表认，认不出留空） */
const newColorHex = ref('');
const receipt = ref('');

/** 被选中的待归一色名（点标准色卡即把它并进该卡）；null = 没选 */
const selectedLoose = ref<string | null>(null);

const matchQ = (name: string) => {
  const q = query.value.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q);
};

/** 标准色（字典里的色，合并目标） */
const standards = computed(() =>
  rows.value.filter((r) => r.inDict && matchQ(r.name)),
);
/** 待归一色名（数字色号 / 平台原文 / 未入字典的异写） */
const loose = computed(() =>
  rows.value.filter((r) => !r.inDict && matchQ(r.name)),
);

const dictCount = computed(() => rows.value.filter((r) => r.inDict).length);
const looseCount = computed(() => rows.value.filter((r) => !r.inDict).length);

/**
 * 款图缩略图（`imagePath` → dataUrl）。只给**待归一**那半区取：
 * 数字色号 / 平台原文那里没有色块，"这个 `5` 是红还是蓝"全靠这张图。
 * 取不到图不挡合并（下一次进页会重试；空占位本身就是"该色还没有图"的如实呈现）。
 */
const thumbs = ref<Record<string, string>>({});

async function loadThumbs(): Promise<void> {
  const want = [
    ...new Set(loose.value.map((r) => r.imagePath).filter((p) => p && !thumbs.value[p])),
  ];
  if (!want.length) return;
  try {
    const res = await orderImageThumbBatch(want.map((localPath) => ({ localPath, maxEdge: 64 })));
    if (!res.success) return;
    want.forEach((p, i) => {
      const url = res.data?.dataUrls?.[i];
      if (url) thumbs.value[p] = url;
    });
  } catch {
    // 缩略图是辅助信息，坏了不该让整块颜色板报错（合并才是这页的主职能）
  }
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await mdColorBoard();
    if (!res.success) throw new Error(res.error || '读取失败');
    rows.value = res.data?.rows ?? [];
    void loadThumbs();
  } catch (e: unknown) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function badgeOf(r: ColorBoardItem): { text: string; tone: string } {
  if (r.numeric) return { text: '数字色号', tone: 'is-numeric' };
  return { text: '未入字典', tone: 'is-loose' };
}

function usageText(r: ColorBoardItem): string {
  const bits: string[] = [];
  if (r.styles) bits.push(`款 ${r.styles}`);
  if (r.skus) bits.push(`SKU ${r.skus}`);
  if (r.orders) bits.push(`订单 ${r.orders}`);
  return bits.join(' · ');
}

/** 色块 hex（字典 hex 优先；其次内置词表；都没有 → ''，界面画虚线空块） */
function swatchOf(r: ColorBoardItem): string {
  if (r.hex) return r.hex;
  return colorSwatchOf(r.name) ?? '';
}

function formatOutcome(o: ColorMergeOutcome): string {
  const bits: string[] = [];
  if (o.styleRenamed) bits.push(`款色改名 ${o.styleRenamed} 行`);
  if (o.styleMerged) bits.push(`款色并掉 ${o.styleMerged} 行`);
  if (o.skusRenamed) bits.push(`SKU 改名 ${o.skusRenamed} 行`);
  if (o.skusMerged) bits.push(`SKU 并掉 ${o.skusMerged} 行`);
  if (o.orders) bits.push(`订单改指 ${o.orders} 行`);
  if (o.keys) bits.push(`变体键 ${o.keys} 条`);
  if (o.parts) bits.push(`套装部件 ${o.parts} 行`);
  if (o.aliases) bits.push(`别名 ${o.aliases} 条`);
  if (o.dictRemoved) bits.push('源色已从字典移除');
  const tail = bits.length ? `：${bits.join('、')}` : '（没有用到它的业务数据）';
  return `已把「${o.source}」并进「${o.target}」${tail}`;
}

/** 选中态提示（占回执那一行） */
const selectHint = computed(() => {
  if (!selectedLoose.value) return '';
  return `已选「${selectedLoose.value}」—— 点下面任一标准色即合并，或点它本身取消`;
});

/** 拖动中的提示（占回执那一行） */
const dragHint = computed(() => {
  if (!dragActive.value || !dragSrc.value) return '';
  if (dragOver.value) return `松手：把「${dragSrc.value}」并进「${dragOver.value}」`;
  return `拖动「${dragSrc.value}」到上面的标准色卡 = 并进那一色（落点色名保留）`;
});

function toggleSelectLoose(name: string): void {
  if (merging.value) return;
  selectedLoose.value = selectedLoose.value === name ? null : name;
}

/**
 * 合并：源 = 待归一色名，目标 = 标准色名。
 * 数字色号只能当源，不能当目标（与主进程同一条校验，前端先拦一次不发请求）。
 */
async function mergeInto(source: string, target: string): Promise<void> {
  if (!source || !target || source === target) return;
  const targetRow = rows.value.find((r) => r.name === target);
  if (targetRow?.numeric) {
    receipt.value = `「${target}」是数字色号，不能当保留色名 —— 先把它认成具体的颜色再合并。`;
    return;
  }
  merging.value = true;
  selectedLoose.value = null;
  try {
    const res = await mdColorMerge({ source, target });
    if (!res.success) {
      receipt.value = res.error || '合并失败';
      return;
    }
    const out = res.data?.result;
    receipt.value = out ? formatOutcome(out) : `已把「${source}」并进「${target}」`;
    await loadColorDict(true);
    await load();
  } catch (e: unknown) {
    receipt.value = e instanceof Error ? e.message : '合并失败';
  } finally {
    merging.value = false;
  }
}

/** 点标准色卡：若有待归一色被选中就合并，否则什么都不做（避免误触） */
function onStandardCardClick(name: string): void {
  if (selectedLoose.value) {
    void mergeInto(selectedLoose.value, name);
  }
}

async function addColor(): Promise<void> {
  const raw = newColor.value.trim();
  if (!raw || adding.value) return;
  adding.value = true;
  try {
    const res = await addColorToDict(raw, newColorHex.value);
    if (!res.ok) {
      receipt.value = res.error || '新增颜色失败';
      return;
    }
    newColor.value = '';
    newColorHex.value = '';
    receipt.value =
      res.created === false ? `「${res.name}」已经在字典里了` : `已新增标准色「${res.name}」`;
    await loadColorDict(true);
    await load();
  } finally {
    adding.value = false;
  }
}

/** 点标准色色块的取色器：改这个色的 hex（只改显示，不改名字） */
async function onHexChange(r: ColorBoardItem, ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement | null;
  const hex = input?.value ?? '';
  if (r.colorId <= 0) return;
  updatingHex.value = r.colorId;
  try {
    const res = await mdColorUpdateHex({ id: r.colorId, hex });
    if (!res.success) {
      receipt.value = res.error || '修改色块失败';
      return;
    }
    const updated = res.data?.color;
    if (updated) {
      const hit = rows.value.find((x) => x.name === r.name);
      if (hit) hit.hex = updated.hex;
    }
    await loadColorDict(true);
  } catch (e: unknown) {
    receipt.value = e instanceof Error ? e.message : '修改色块失败';
  } finally {
    updatingHex.value = null;
  }
}

// ── 拖行合并（保留为快捷方式：拖待归一行到标准色卡）────────────────────

const rootEl = ref<HTMLElement | null>(null);
const dragSrc = ref<string | null>(null);
const dragOver = ref<string | null>(null);
const dragActive = ref(false);
let rowDrag: { name: string; x: number; y: number } | null = null;
let swallowClick = false;

let selectionLock = false;
function blockSelectStart(e: Event): void {
  e.preventDefault();
}
function lockTextSelection(): void {
  if (selectionLock) return;
  selectionLock = true;
  document.addEventListener('selectstart', blockSelectStart, true);
  const sel = document.getSelection();
  if (sel && !sel.isCollapsed) sel.removeAllRanges();
  window.addEventListener('pointerup', unlockTextSelection, { once: true });
  window.addEventListener('pointercancel', unlockTextSelection, { once: true });
}
function unlockTextSelection(): void {
  if (!selectionLock) return;
  selectionLock = false;
  document.removeEventListener('selectstart', blockSelectStart, true);
}

const DROP_PAD_X = 16;
const DROP_PAD_Y = 12;

function dropDistance(rect: DOMRect, x: number, y: number): number | null {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  if (dx > DROP_PAD_X || dy > DROP_PAD_Y) return null;
  return Math.hypot(dx, dy);
}

function resolveDropAt(x: number, y: number): void {
  let best: { name: string; d: number } | null = null;
  const root = rootEl.value;
  if (root && dragSrc.value) {
    for (const el of root.querySelectorAll<HTMLElement>('[data-std-card]')) {
      const name = el.dataset.stdCard ?? '';
      if (!name || name === dragSrc.value) continue;
      const d = dropDistance(el.getBoundingClientRect(), x, y);
      if (d === null) continue;
      if (!best || d < best.d) best = { name, d };
    }
  }
  dragOver.value = best ? best.name : null;
}

function onLooseDown(name: string, e: PointerEvent): void {
  if (merging.value || e.button !== 0) return;
  rowDrag = { name, x: e.clientX, y: e.clientY };
  lockTextSelection();
}

function onRowMove(e: PointerEvent): void {
  if (!rowDrag) return;
  if (!dragActive.value) {
    const dx = e.clientX - rowDrag.x;
    const dy = e.clientY - rowDrag.y;
    if (Math.hypot(dx, dy) < 6) return;
    dragActive.value = true;
    dragSrc.value = rowDrag.name;
    window.addEventListener('pointerup', onAnyPointerUp, { once: true });
  }
  resolveDropAt(e.clientX, e.clientY);
}

function onAnyPointerUp(e: PointerEvent): void {
  if (dragActive.value) resolveDropAt(e.clientX, e.clientY);
  endDrag();
}

function onRowUp(e?: PointerEvent): void {
  if (dragActive.value && e) resolveDropAt(e.clientX, e.clientY);
  endDrag();
}

function abortDrag(): void {
  rowDrag = null;
  unlockTextSelection();
  window.removeEventListener('pointerup', onAnyPointerUp);
  dragActive.value = false;
  dragSrc.value = null;
  dragOver.value = null;
}

function endDrag(): void {
  const src = dragSrc.value;
  const to = dragOver.value;
  const active = dragActive.value;
  rowDrag = null;
  unlockTextSelection();
  window.removeEventListener('pointerup', onAnyPointerUp);
  dragActive.value = false;
  dragSrc.value = null;
  dragOver.value = null;
  if (!active || !src) return;
  swallowClick = true;
  setTimeout(() => {
    swallowClick = false;
  }, 0);
  if (to) void mergeInto(src, to);
}

function onRootClickCapture(e: MouseEvent): void {
  if (!swallowClick) return;
  swallowClick = false;
  e.stopPropagation();
  e.preventDefault();
}

function onVisibilityChange(): void {
  if (document.hidden) abortDrag();
}

onMounted(() => {
  void load();
  window.addEventListener('blur', abortDrag);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onBeforeUnmount(() => {
  window.removeEventListener('blur', abortDrag);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pointerup', onAnyPointerUp);
  unlockTextSelection();
});
</script>

<template>
  <div
    ref="rootEl"
    class="colors-panel"
    data-act="colors-panel"
    @pointermove="onRowMove"
    @pointerup="onRowUp"
    @pointercancel="onRowUp"
    @click.capture="onRootClickCapture"
    @dragstart.prevent
  >
    <div class="colors-bar">
      <div class="colors-chips" data-act="colors-stats">
        <span class="colors-chip">共 <b>{{ rows.length }}</b> 个色名</span>
        <span class="colors-chip">标准色 <b>{{ dictCount }}</b></span>
        <span class="colors-chip">待归一 <b>{{ looseCount }}</b></span>
      </div>
      <div class="colors-acts">
        <input
          v-model="query"
          class="wb-input colors-search"
          type="search"
          placeholder="搜色名或色号"
          data-act="colors-search"
        />
        <input
          v-model="newColor"
          class="wb-input colors-new"
          type="text"
          maxlength="40"
          placeholder="新增标准色名（如 卡其）"
          data-act="colors-new-input"
          @keydown.enter.prevent="addColor"
        />
        <label class="colors-hex-label" title="选一个真实色块（留空用内置词表认）">
          <input
            v-model="newColorHex"
            class="colors-hex"
            type="color"
            data-act="colors-new-hex"
          />
        </label>
        <button
          class="wb-btn wb-btn--primary"
          type="button"
          data-act="colors-add"
          :disabled="adding || !newColor.trim()"
          @click="addColor"
        >
          新增
        </button>
      </div>
    </div>

    <p v-if="loadError" class="wb-notice wb-notice--error" data-act="colors-error">
      {{ loadError }}
      <button class="wb-link" type="button" @click="load">重试</button>
    </p>

    <!-- 回执 / 选中提示 / 拖动提示共用一行：只显示最新那条，不让界面长高 -->
    <p
      v-if="dragHint || selectHint || receipt"
      class="wb-notice colors-receipt"
      data-act="colors-receipt"
    >
      {{ dragHint || selectHint || receipt }}
    </p>

    <!-- 标准色（合并目标）：色卡 = 真实色块，大目标方便点/拖 -->
    <section class="colors-sec">
      <h3 class="colors-sec__title">
        标准色
        <span class="colors-sec__sub">合并目标；点色块可改色值，先选待归一再点色卡即合并</span>
      </h3>
      <div v-if="!standards.length" class="wb-muted colors-pad">没有匹配的标准色</div>
      <div v-else class="colors-cards">
        <div
          v-for="r in standards"
          :key="r.name"
          class="std-card"
          role="button"
          tabindex="0"
          :class="{
            'is-drop-target': !!selectedLoose && selectedLoose !== r.name,
            'is-over': dragActive && dragOver === r.name,
          }"
          :data-std-card="r.name"
          :data-color="r.name"
          :title="
            selectedLoose && selectedLoose !== r.name
              ? `把「${selectedLoose}」并进「${r.name}」`
              : '色块可点取色器修改；先选下面待归一再点此卡合并'
          "
          @click="onStandardCardClick(r.name)"
        >
          <label class="std-card__swatch" :title="'色块：' + (swatchOf(r) || '未设色值')" @click.stop>
            <span
              class="std-card__dot"
              :class="{ 'is-empty': !swatchOf(r) }"
              :style="swatchOf(r) ? { background: swatchOf(r) } : undefined"
            ></span>
            <input
              type="color"
              class="std-card__picker"
              :value="swatchOf(r) || '#000000'"
              :data-std-swatch="r.name"
              @input="onHexChange(r, $event)"
            />
          </label>
          <span class="std-card__body">
            <span class="std-card__name">{{ r.name }}</span>
            <span class="std-card__hex" data-std-hex>{{ swatchOf(r) || '未设色值' }}</span>
            <span class="std-card__usage" data-std-usage>
              {{ usageText(r) || '没用到' }}
            </span>
          </span>
        </div>
      </div>
    </section>

    <!-- 待归一色名：没有色块（"还没认"就是没色块）；点行选中，再点上面标准色卡合并 -->
    <section class="colors-sec">
      <h3 class="colors-sec__title">
        待归一
        <span class="colors-sec__sub">数字色号 / 平台原文 / 未入字典的异写色 —— 选中后点上面标准色合并</span>
      </h3>
      <div v-if="loading && !rows.length" class="wb-muted colors-pad">正在读取…</div>
      <div
        v-else-if="!loose.length"
        class="wb-empty colors-pad"
        data-act="colors-empty"
      >
        <p class="wb-empty__title">
          {{ query.trim() ? '没有匹配的待归一色名' : '所有色名已在字典里' }}
        </p>
        <p class="wb-empty__desc">
          同一个颜色写成两个名字时，在下面选中异写名，再点上面的标准色卡即可合并。
        </p>
      </div>
      <div v-else class="wb-table-wrap colors-scroll">
        <table class="wb-table colors-tbl" data-act="colors-table">
          <thead>
            <tr>
              <th class="colors-col-name">色名</th>
              <th class="colors-col-img">款图</th>
              <th class="colors-col-src">来源</th>
              <th class="colors-col-usage">用量</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in loose"
              :key="r.name"
              class="loose-row"
              :class="{
                'is-selected': selectedLoose === r.name,
                'is-src': dragActive && dragSrc === r.name,
              }"
              :data-loose-row="r.name"
              :data-color="r.name"
              :title="selectedLoose === r.name ? '已选中 —— 点上面标准色卡合并，或再点一次取消' : '点一下选中，再点上面的标准色卡合并'"
              @pointerdown="onLooseDown(r.name, $event)"
              @click="toggleSelectLoose(r.name)"
            >
              <td>
                <span class="loose-row__name">{{ r.name }}</span>
              </td>
              <td>
                <span class="loose-row__img" data-loose-img>
                  <img
                    v-if="r.imagePath && thumbs[r.imagePath]"
                    class="wb-thumb loose-row__thumb"
                    :src="thumbs[r.imagePath]"
                    :alt="r.name"
                  />
                  <span
                    v-else
                    class="wb-thumb wb-thumb--empty loose-row__thumb"
                    :title="r.imagePath ? '图还没读出来（重开本页会再取一次）' : '这个色还没有款图'"
                  ></span>
                </span>
              </td>
              <td>
                <span class="colors-badge" :class="badgeOf(r).tone" data-loose-badge>
                  {{ badgeOf(r).text }}
                </span>
              </td>
              <td class="colors-usage" data-loose-usage>
                {{ usageText(r) || '没用到' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.colors-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  flex: 1 1 auto;
  /* 这一页不出整页滚动条（2026-10-31 用户口径「不要出现滚动条，要全部都展示出来」）：
     标准色区按内容铺开、不滚；名单在自己的框里滚。整页不滚 = `overflow: hidden`，
     绝不能写 auto —— 差 2px 也会冒出一条滚动条（2026-10-31 冒烟实测面板溢出 2px）。 */
  overflow: hidden;
}
.colors-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.colors-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.colors-chip {
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 12px;
}
.colors-chip b {
  color: var(--wb-text);
  font-weight: 600;
}
.colors-acts {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.colors-search {
  width: 160px;
  height: 30px;
  font-size: 12.5px;
}
.colors-new {
  width: 190px;
  height: 30px;
  font-size: 12.5px;
}
.colors-hex-label {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 4px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-surface);
  cursor: pointer;
}
.colors-hex {
  width: 28px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}
.colors-receipt {
  flex-shrink: 0;
  margin: 0;
}
/* 空态 / 读盘中占位也是 flex 子项：不给 `min-height:auto` 的话，窄视口下它按内容
   （约 101px）顶住不肯缩，待归一区就比父面板多出 2px —— 面板即使 overflow:hidden，
   内容也是被切掉的（2026-10-31 冒烟实测 panelScroll=2）。让它可缩、超高时自己滚。 */
.colors-pad {
  padding: 16px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.colors-empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.colors-sec {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  /* 标准色区按内容铺开（不压缩、不自己滚）；待归一区在下面单独覆盖成可伸缩 */
  flex: 0 0 auto;
}
/* 待归一区：占满标准色之后的剩余高度，内部表格独立滚动 */
.colors-sec:last-of-type {
  flex: 1 1 auto;
}
.colors-sec__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-text);
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.colors-sec__sub {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--wb-text-muted);
}

/* 标准色卡：合并目标。2026-10-31 压成「色块 20px + 两行小字」——
   27 个种子色在 1200 窗口下约 4~5 行全部露出，不再出一条区内的滚动条。 */
.colors-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 6px;
  align-content: start;
}
.std-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  text-align: left;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  cursor: default;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.std-card:hover {
  border-color: var(--wb-border-strong);
}
/* 有待归一色被选中时，所有标准色卡都是"可合并"目标 */
.std-card.is-drop-target {
  cursor: pointer;
  border-color: var(--wb-primary);
  box-shadow: 0 0 0 1px var(--wb-primary-soft);
}
.std-card.is-over {
  background: var(--wb-primary-soft);
  outline: 2px solid var(--wb-primary);
  outline-offset: -2px;
}
.std-card__swatch {
  position: relative;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  cursor: pointer;
}
.std-card__dot {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 5px;
  border: 1px solid var(--wb-border);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
}
.std-card__dot.is-empty {
  background: transparent;
  border-style: dashed;
}
.std-card__picker {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}
.std-card__body {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
}
.std-card__name {
  flex: 1 0 100%;
  max-width: 100%;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--wb-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.std-card__hex {
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--wb-text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.std-card__usage {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--wb-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 待归一行：带款图（数字色号靠它认色），点行选中 */
.colors-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.colors-tbl {
  width: 100%;
}
/* 色名列收成内容宽（原来 46% 留白太多，看起来不协调）；余宽全部让给用量列 */
.colors-col-name {
  width: 1%;
}
.colors-col-img {
  width: 44px;
}
.colors-col-src {
  width: 92px;
}
/* sticky 首列（`.wb-table-wrap` 给第一列固定底色）：色名列是"这一行是谁"，
   与图片列互换过顺序就会让 sticky 停在图片上（横滚时反而丢了身份） */
.colors-tbl th:first-child,
.colors-tbl td:first-child {
  white-space: nowrap;
}
.loose-row {
  user-select: none;
  cursor: pointer;
}
.loose-row:hover {
  background: var(--wb-surface-2);
}
.loose-row.is-selected {
  background: var(--wb-primary-soft);
  outline: 1px solid var(--wb-primary);
  outline-offset: -1px;
}
.loose-row.is-src {
  opacity: 0.45;
}
.loose-row__name {
  font-size: 13px;
  color: var(--wb-text);
}
.loose-row__img {
  display: inline-flex;
  align-items: center;
}
/* 覆盖全局 `.wb-thumb` 的 40px：这条列表一行一项，32px 够认色又不把行撑高 */
.loose-row__thumb {
  width: 32px;
  height: 32px;
  border-radius: 6px;
}
.colors-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 4px;
  font-size: 11.5px;
  font-weight: 600;
}
.colors-badge.is-loose {
  background: var(--wb-warning-soft);
  color: var(--wb-warning);
}
.colors-badge.is-numeric {
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
}
.colors-usage {
  color: var(--wb-text-muted);
  font-size: 12.5px;
}
</style>
