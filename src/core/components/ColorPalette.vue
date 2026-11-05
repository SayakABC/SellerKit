<!-- src/core/components/ColorPalette.vue
     通用「常用色」条 —— 产品编辑（SKU 矩阵）与归类核对页共用。
     2026-10-30 用户口径：
       「编辑产品中的颜色修改为不能修改，可以改成可多选，点击选中，批量拖动到常用色中选择颜色，
         如果不存在颜色，可以在常用色后面新增颜色，这可以做成通用的页面或方法，
         可供产品编辑页和归类核对页使用」

     它只负责**展示与交互**：
       · 一排色点胶囊（点一下 = emit pick，由调用方决定"加一色"还是"把选中色归类到这个色"）；
       · 拖放落点（调用方把 `dragging` / `dropColor` 传进来，几何判定仍由调用方做）；
       · 末尾「＋ 新增颜色」（写字典走 `addColorToDict`，成功后 emit added，**不自动加行**）。

     为什么"新增"不直接加一色：那会让一次笔误变成"这个款多了一色"，还得再删一次。
     加进字典只代表"以后在哪都能选到它"。 -->
<template>
  <div class="cp" :class="{ 'cp--compact': compact, 'cp--dragging': dragging }">
    <button
      v-for="c in colors"
      :key="`cp-${c}`"
      class="cp__chip"
      :class="{
        'is-in': isPresent(c),
        'is-current': current === c,
        'is-drop': dragging && dropColor === c,
      }"
      type="button"
      :data-act="`${act}-common`"
      :data-color="c"
      v-bind="dropAttr ? { [dropAttr]: c } : {}"
      :disabled="disabled"
      :title="chipTitle(c)"
      @click="emit('pick', c)"
    >
      <span class="cp__dot" :style="{ background: colorSwatchOf(c) ?? 'transparent' }"></span>
      {{ c }}
    </button>

    <template v-if="allowAdd">
      <button
        v-if="!adding"
        class="cp__add"
        type="button"
        :data-act="`${act}-color-add`"
        :disabled="disabled"
        title="字典里没有这个色？加进常用色（只加字典，不给当前款加色）"
        @click="startAdd"
      >
        ＋ 新增颜色
      </button>
      <span v-else class="cp__editor">
        <input
          ref="inputEl"
          v-model="draft"
          class="wb-input cp__input"
          type="text"
          maxlength="40"
          autocomplete="off"
          placeholder="新颜色名"
          :data-act="`${act}-color-add-input`"
          :aria-label="`新增颜色名（${act}）`"
          @keydown.enter.prevent="confirmAdd"
          @keydown.esc.prevent="cancelAdd"
        />
        <button
          class="cp__ok"
          type="button"
          :data-act="`${act}-color-add-ok`"
          :disabled="addingBusy"
          title="加进常用色"
          @click="confirmAdd"
        >
          {{ addingBusy ? '…' : '确定' }}
        </button>
        <button
          class="cp__cancel"
          type="button"
          :data-act="`${act}-color-add-cancel`"
          :disabled="addingBusy"
          title="取消（Esc）"
          @click="cancelAdd"
        >
          ✕
        </button>
        <span
          v-if="errMsg"
          class="cp__err"
          :data-act="`${act}-color-add-err`"
          role="alert"
          >{{ errMsg }}</span
        >
      </span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { addColorToDict, colorSwatchOf } from '@/core/services/colorDict';

const props = withDefaults(
  defineProps<{
    /** 要展示的色名（来自共享颜色字典，或归类页某款的色卡） */
    colors: string[];
    /** 已在本次操作里"有了"的色名：打勾 + 灰底（矩阵 = 已在矩阵里；归类页一般不放） */
    present?: string[];
    /** 单选高亮（归类页的当前色） */
    current?: string;
    disabled?: boolean;
    /** 末尾是否出现「＋ 新增颜色」 */
    allowAdd?: boolean;
    /** data-act 前缀，默认 `color`；两个页面各自传，避免选择器撞车 */
    act?: string;
    compact?: boolean;
    /** 拖动中悬停的色名（调用方做几何判定后透传） */
    dropColor?: string;
    dragging?: boolean;
    /** 供调用方按几何取落点用的 data 属性名，如 `data-mx-pc` */
    dropAttr?: string;
    /** 已选色数（命中标题文案"把已选 N 色归到「x」"） */
    selectedCount?: number;
    titleFor?: (color: string) => string;
  }>(),
  {
    present: () => [],
    current: '',
    disabled: false,
    allowAdd: false,
    act: 'color',
    compact: false,
    dropColor: '',
    dragging: false,
    dropAttr: '',
    selectedCount: 0,
    titleFor: undefined,
  }
);

const emit = defineEmits<{
  (e: 'pick', color: string): void;
  (e: 'added', color: string): void;
}>();

const adding = ref(false);
const addingBusy = ref(false);
const draft = ref('');
const errMsg = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

function isPresent(c: string): boolean {
  return props.present.includes(c);
}

function chipTitle(c: string): string {
  if (props.titleFor) return props.titleFor(c);
  if (props.selectedCount > 0) return `把已选 ${props.selectedCount} 色归到「${c}」`;
  return `点一下用「${c}」；拖动时这里是落点`;
}

async function startAdd(): Promise<void> {
  if (props.disabled) return;
  adding.value = true;
  errMsg.value = '';
  draft.value = '';
  await nextTick();
  inputEl.value?.focus();
}

function cancelAdd(): void {
  adding.value = false;
  addingBusy.value = false;
  draft.value = '';
  errMsg.value = '';
}

async function confirmAdd(): Promise<void> {
  if (addingBusy.value) return;
  const name = draft.value.trim();
  if (!name) {
    errMsg.value = '颜色名不能为空';
    return;
  }
  addingBusy.value = true;
  errMsg.value = '';
  const res = await addColorToDict(name);
  addingBusy.value = false;
  if (!res.ok) {
    errMsg.value = res.error || '新增颜色失败';
    return;
  }
  adding.value = false;
  draft.value = '';
  emit('added', res.name);
}
</script>

<style scoped>
.cp {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.cp--compact {
  gap: 3px;
}
/* 24px 是拖放落点的手感下限（22px 时点在胶囊上下边缘会脱靶，2026-10-25 实测）。
   27 色时压**宽度**而不是高度：字号 11、内边距 6、色点 8。 */
.cp__chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  padding: 0 6px;
  font-size: 11px;
  color: var(--wb-text);
  border: 1px solid var(--wb-border);
  border-radius: 999px;
  background: var(--wb-surface);
  cursor: pointer;
}
.cp--compact .cp__chip {
  height: 22px;
  padding: 0 5px;
  font-size: 11px;
}
.cp__chip:hover:not(:disabled) {
  border-color: var(--wb-border-strong);
}
.cp__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}
/* 已经在矩阵/本次操作里的色：打勾 + 变灰（这一排于是同时回答"还差哪些"） */
.cp__chip.is-in {
  color: var(--wb-text-muted);
  background: var(--wb-surface-2);
  border-style: dashed;
}
.cp__chip.is-in::after {
  content: '✓';
  font-size: 10px;
}
/* 单选高亮（归类页的当前色）：实心描边，与"可点"区分 */
.cp__chip.is-current {
  border-color: var(--wb-focus);
  background: var(--wb-focus-ring);
  color: var(--wb-text);
}
/* 拖动中：整排是落点，描边提亮；不加高、不加 padding（布局跳动会让落点从指针底下跑掉） */
.cp--dragging .cp__chip {
  border-color: var(--wb-focus);
  border-style: dashed;
  background: var(--wb-surface);
  cursor: copy;
}
/* 悬停中的那一个：实心 + 外环 + 反白 */
.cp--dragging .cp__chip.is-drop,
.cp--dragging .cp__chip.is-drop.is-in,
.cp--dragging .cp__chip.is-drop.is-current {
  color: var(--wb-primary-contrast);
  background: var(--wb-primary);
  border-color: var(--wb-primary);
  border-style: solid;
  box-shadow: 0 0 0 2px var(--wb-focus-ring);
}
.cp--dragging .cp__chip.is-drop .cp__dot {
  box-shadow:
    inset 0 0 0 1px rgba(0, 0, 0, 0.12),
    0 0 0 1.5px #fff;
}
/* 「＋ 新增颜色」：虚线胶囊，视觉上属于这一排但明显不是数据 */
.cp__add {
  height: 24px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--wb-text-muted);
  background: transparent;
  border: 1px dashed var(--wb-border);
  border-radius: 999px;
  cursor: pointer;
}
.cp--compact .cp__add {
  height: 22px;
  padding: 0 6px;
}
.cp__add:hover:not(:disabled) {
  color: var(--wb-text);
  border-color: var(--wb-border-strong);
}
.cp__editor {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-wrap: wrap;
}
.cp__input {
  width: 92px;
  height: 24px;
  font-size: 11px;
  padding: 0 6px;
}
.cp__ok,
.cp__cancel {
  height: 24px;
  padding: 0 6px;
  font-size: 11px;
  border-radius: var(--wb-radius-sm);
  border: 1px solid var(--wb-border);
  background: var(--wb-surface);
  color: var(--wb-text);
  cursor: pointer;
}
.cp__ok {
  border-color: var(--wb-primary);
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
}
.cp__err {
  font-size: 11px;
  color: var(--wb-danger, #d64545);
}
</style>
