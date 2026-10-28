<template>
  <!-- 带图款列表（2026-10-28）：单品挑款（`StylePicker`）与批量定款（`BulkStylePicker`）**共用这一份**。
       ─────────────────────────────────────────────────────────────────────
       为什么抽出来：两处都要"搜索 + 含停用 + 款首图 + 键盘上下"。各写一份的直接后果是
       **取图链路写两遍**（`styleImages` → `orderImageThumbBatch`，少接一条就整列空占位且不报错），
       以及"批量里能搜停用、单品里搜不到"这类漂移。

       ⚠️ 本组件**不写库、不管颜色**：只把"用户点了哪一款"交回调用方。
          颜色是行级的（同一款不同订单可以不同色），单品与批量的处理方式不同 ⇒ 由父层决定。

       ⚠️ `prefix` 决定所有 `data-act` 前缀（`sp-*` / `bp-*`）：既有冒烟按 `sp-item-S1` 这类选择器
          断言单品弹层，前缀必须保留，否则换组件会静默让那些断言"查不到元素"。 -->
  <div class="sl">
    <div class="sl-toolbar">
      <input
        ref="searchEl"
        v-model="keyword"
        class="wb-input wb-input--sm sl-search"
        type="search"
        :data-act="`${prefix}-search`"
        :placeholder="placeholder"
        aria-label="搜索归属款"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="enter"
      />
      <label class="sl-check">
        <input v-model="includeArchived" type="checkbox" :data-act="`${prefix}-include-archived`" />
        含停用
      </label>
    </div>

    <div class="sl-list" role="listbox" :data-act="`${prefix}-list`">
      <button
        v-for="(s, i) in filtered"
        :key="s.code"
        type="button"
        role="option"
        :aria-selected="current === s.code"
        class="sl-item"
        :class="{ 'is-on': current === s.code, 'is-cursor': i === cursor }"
        :data-act="`${prefix}-item-${s.code}`"
        :data-code="s.code"
        @click="choose(s, 'click')"
      >
        <!-- 款首图：取不到就空占位（图是"帮你认"，不是"能不能选"的前提） -->
        <img v-if="thumbs[s.code]" :src="thumbs[s.code]" class="wb-thumb sl-item__img" alt="" />
        <span v-else class="wb-thumb wb-thumb--empty sl-item__img" :data-act="`${prefix}-thumb-empty`"></span>
        <span class="wb-mono sl-item__code">{{ s.code }}</span>
        <span class="sl-item__name">{{ s.name || '—' }}</span>
        <span class="wb-muted sl-item__meta">
          {{ s.colors.length ? `${s.colors.length} 个颜色` : '还没录颜色'
          }}{{ s.status === 'archived' ? ' · 停用' : '' }}
        </span>
      </button>
      <p
        v-if="!filtered.length"
        class="wb-muted sl-empty"
        :data-act="`${prefix}-empty`"
      >
        {{ keyword ? '没有匹配的款 —— 换个编码或名字试试' : '产品库里还没有款 —— 先到「产品管理」建档' }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
// 带图款列表（两处共用）。三条纪律：
//   ① **图是主判据** —— 款首图与订单图并排，才谈得上"拿图挑款"；
//   ② 数据已在内存（父层 `listStyleOptions()` 一次取到）⇒ 搜索是**本地过滤**，不发 IPC；
//   ③ 取图两条通道**必须串起来**（`styleImages` 给路径、`orderImageThumbBatch` 才出图），
//      且失败**静默**：图取不到就空占位，不影响"能不能选"。
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { orderImageThumbBatch } from '@/core/services/ipc';
import { styleImages } from '../purchase';
import type { StyleRecord } from '@/types';

const props = withDefaults(
  defineProps<{
    /** 款全集（父层已取；含停用款） */
    styles: StyleRecord[];
    /** 当前已选款编码（高亮用，可空） */
    current?: string;
    /** `data-act` 前缀：`sp`（单品弹层）/ `bp`（批量弹层） */
    prefix?: string;
    placeholder?: string;
    /** 款图边长（列表里 128 够看清"是不是这一款"） */
    maxEdge?: number;
  }>(),
  { current: '', prefix: 'sl', placeholder: '搜索款编码 / 款名…', maxEdge: 128 }
);

const emit = defineEmits<{
  /**
   * 选中一个款。
   * `via` 区分来源：`enter`（搜索框回车 = "只要一款"的快路径，父层可据此直接提交）、
   * `click`（鼠标点选，父层只回填不提交 —— 用户可能还要看色卡）。
   */
  pick: [style: StyleRecord, via: 'click' | 'enter'];
}>();

/** 一次最多画多少行 —— 款可能有几百个，全画进 DOM 会顿（搜索就是用来缩小范围的） */
const MAX_ROWS = 60;

const keyword = ref('');
/** 已生效的关键字（本地过滤，输入即筛 —— 与产品页同一手感） */
const applied = ref('');
/** 默认含停用：与换控件前的原生下拉一致（历史订单可能正指向停用款） */
const includeArchived = ref(true);
const cursor = ref(-1);
const searchEl = ref<HTMLInputElement | null>(null);

/** 款图（code → dataUrl）。合批取，只取当前可见的那几十行 */
const thumbs = ref<Record<string, string>>({});

const filtered = computed(() => {
  const k = applied.value.toLowerCase();
  const out: StyleRecord[] = [];
  for (const s of props.styles) {
    if (!includeArchived.value && s.status === 'archived') continue;
    if (k && !s.code.toLowerCase().includes(k) && !String(s.name || '').toLowerCase().includes(k)) continue;
    out.push(s);
    if (out.length >= MAX_ROWS) break;
  }
  return out;
});

function choose(s: StyleRecord, via: 'click' | 'enter'): void {
  cursor.value = filtered.value.findIndex((x) => x.code === s.code);
  emit('pick', s, via);
}

function move(delta: number): void {
  if (!filtered.value.length) return;
  const next = Math.min(Math.max(cursor.value + delta, 0), filtered.value.length - 1);
  const row = filtered.value[next];
  if (row) choose(row, 'enter');
}

/** 搜索框里按回车：选中当前高亮的款（没有高亮就取第一条）—— 让"只敲编码"这条路不依赖鼠标 */
function enter(): void {
  const row = filtered.value[cursor.value] ?? filtered.value[0];
  if (row) choose(row, 'enter');
}

let thumbSeq = 0;
async function loadThumbs(): Promise<void> {
  const seq = ++thumbSeq;
  const want = filtered.value.filter((s) => !thumbs.value[s.code]);
  if (!want.length) return;
  try {
    const paths = await styleImages({
      items: want.map((s) => ({ styleCode: s.code, color: s.colors[0] ?? '' })),
    });
    const hit: { code: string; path: string }[] = [];
    want.forEach((s, i) => {
      const p = paths[i];
      if (p) hit.push({ code: s.code, path: p });
    });
    if (!hit.length) return;
    const t = await orderImageThumbBatch(hit.map((h) => ({ localPath: h.path, maxEdge: props.maxEdge })));
    if (seq !== thumbSeq) return; // 搜索换过一轮 ⇒ 这次的结果作废
    if (!t.success) return;
    const urls = t.data?.dataUrls ?? [];
    const next = { ...thumbs.value };
    hit.forEach((h, i) => {
      const url = urls[i];
      if (url) next[h.code] = url;
    });
    thumbs.value = next;
  } catch {
    /* 图取不到就空占位，不打断选择 */
  }
}

watch(keyword, (v) => {
  applied.value = v.trim();
  cursor.value = -1;
  void nextTick(() => void loadThumbs());
});
watch(includeArchived, () => {
  cursor.value = -1;
  void nextTick(() => void loadThumbs());
});
watch(filtered, () => void loadThumbs(), { immediate: true });

onMounted(() => {
  // 焦点直接落在搜索框：款多的时候"打字缩小范围"是唯一快的路，不该还要先点一下
  void nextTick(() => searchEl.value?.focus());
});

defineExpose({
  /** 让父层在"批量里切换到下一个组"之后把焦点送回搜索框（否则键盘流断掉） */
  focusSearch: (): void => void nextTick(() => searchEl.value?.focus()),
});
</script>

<style scoped>
.sl {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.sl-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sl-search {
  flex: 1;
  min-width: 0;
}

.sl-check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
}

.sl-list {
  min-height: 180px;
  max-height: 42vh;
  overflow: auto;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-surface-2);
}

.sl-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-bottom: 1px solid var(--wb-border);
  background: none;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.sl-item:last-child {
  border-bottom: none;
}
.sl-item:hover,
.sl-item.is-cursor {
  background: var(--wb-hover);
}
.sl-item.is-on {
  background: var(--wb-primary-soft);
}

/* 款图给 36px（比表格里的 96 小一档）：一屏要放下十几款，图太大就变成刷图了 */
.sl-item__img {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  object-fit: contain;
}

.sl-item__code {
  width: 110px;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sl-item__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sl-item__meta {
  flex-shrink: 0;
  font-size: 12px;
}

.sl-empty {
  padding: 36px 0;
  margin: 0;
  text-align: center;
}
</style>
