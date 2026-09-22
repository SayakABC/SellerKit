<script setup lang="ts">
// 分组维度选择器（分组视图工具栏）：勾选顺序 = 分组层级顺序（L1 为最外层）。
// 选中维度可上移 / 下移调整层级；样式自包含，不与 ShopAccountsView 的表格 / 卡片样式交叠。
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { GROUP_FIELDS, groupFieldLabel, useShopAccountsStore } from '../store';
import IconGlyph from './IconGlyph.vue';

const store = useShopAccountsStore();

const root = ref<HTMLElement | null>(null);
const open = ref(false);

function onDocumentClick(event: MouseEvent): void {
  const el = root.value;
  if (el && !el.contains(event.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener('click', onDocumentClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick));
</script>

<template>
  <div ref="root" class="group-picker">
    <button
      class="picker-btn"
      :class="{ 'is-on': store.activeGroupFields.length > 0 }"
      type="button"
      title="选择归类维度（勾选顺序即分级顺序）"
      @click.stop="open = !open"
    >
      <IconGlyph name="layers" :size="13" />
      <span>分组维度</span>
      <span v-if="store.activeGroupFields.length" class="picker-badge">
        {{ store.activeGroupFields.length }}
      </span>
      <IconGlyph name="chevron-down" :size="11" />
    </button>

    <div v-if="open" class="picker-panel" @click.stop>
      <div class="panel-head">
        <span class="panel-title">分组维度</span>
        <button
          v-if="store.groupFields.length"
          class="link-btn"
          type="button"
          @click="store.clearGroupFields()"
        >
          清空
        </button>
      </div>

      <p v-if="!store.groupFields.length" class="panel-hint">
        勾选字段作为归类维度；勾选顺序即分级顺序。
      </p>
      <ul v-else class="dim-list">
        <li v-for="(field, i) in store.groupFields" :key="field" class="dim-row">
          <span class="dim-order">L{{ i + 1 }}</span>
          <span class="dim-name">{{ groupFieldLabel(field) }}</span>
          <button
            class="dim-btn"
            type="button"
            title="上移一层"
            :disabled="i === 0"
            @click="store.moveGroupField(field, -1)"
          >
            ↑
          </button>
          <button
            class="dim-btn"
            type="button"
            title="下移一层"
            :disabled="i === store.groupFields.length - 1"
            @click="store.moveGroupField(field, 1)"
          >
            ↓
          </button>
          <button
            class="dim-btn is-remove"
            type="button"
            :title="`移除「${groupFieldLabel(field)}」`"
            @click="store.toggleGroupField(field)"
          >
            ×
          </button>
        </li>
      </ul>

      <div class="panel-sep" />

      <button
        v-for="meta in GROUP_FIELDS"
        :key="meta.field"
        class="opt-row"
        :class="{ 'is-on': store.groupFields.includes(meta.field) }"
        type="button"
        @click="store.toggleGroupField(meta.field)"
      >
        <span class="opt-check">
          <IconGlyph v-if="store.groupFields.includes(meta.field)" name="check" :size="11" />
        </span>
        <span class="opt-name">{{ meta.label }}</span>
        <span v-if="meta.multi" class="opt-tag" title="多值维度：一套店铺可归入多个组">多值</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.group-picker {
  position: relative;
  display: inline-flex;
}
.picker-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  color: var(--wb-text-muted);
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.picker-btn:hover {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}
.picker-btn.is-on {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
  color: var(--wb-primary);
}
.picker-badge {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--wb-primary);
  color: var(--wb-primary-contrast);
  font-size: 10.5px;
  line-height: 15px;
  text-align: center;
}
.picker-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  width: 236px;
  padding: 6px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  box-shadow: 0 8px 24px var(--wb-overlay);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px 2px;
}
.panel-title {
  font-size: 11px;
  color: var(--wb-text-muted);
}
.link-btn {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--wb-primary);
  font-size: 11px;
  cursor: pointer;
}
.panel-hint {
  margin: 4px 8px 6px;
  color: var(--wb-text-muted);
  font-size: 11.5px;
  line-height: 1.6;
}
.dim-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.dim-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 4px;
}
.dim-row:hover {
  background: var(--wb-surface-2);
}
.dim-order {
  flex-shrink: 0;
  width: 20px;
  color: var(--wb-primary);
  font-size: 10.5px;
  font-weight: 600;
}
.dim-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--wb-text);
  font-size: 12.5px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dim-btn {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  background: var(--wb-surface);
  color: var(--wb-text-muted);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.dim-btn:hover:not(:disabled) {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}
.dim-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.dim-btn.is-remove:hover {
  border-color: var(--wb-danger);
  color: var(--wb-danger);
}
.panel-sep {
  height: 1px;
  margin: 6px 4px;
  background: var(--wb-border);
}
.opt-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--wb-text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.opt-row:hover {
  background: var(--wb-hover);
}
.opt-row.is-on {
  color: var(--wb-primary);
}
.opt-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border: 1px solid var(--wb-border);
  border-radius: 3px;
  background: var(--wb-surface);
  color: var(--wb-primary);
}
.opt-row.is-on .opt-check {
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
.opt-name {
  flex: 1 1 auto;
  min-width: 0;
}
.opt-tag {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--wb-surface-2);
  color: var(--wb-text-muted);
  font-size: 10.5px;
  line-height: 1.7;
}
</style>
