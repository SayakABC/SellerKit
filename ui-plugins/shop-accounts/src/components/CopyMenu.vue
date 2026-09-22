<script setup lang="ts">
// 行内「一键复制」菜单：按预置模板（ERP 登录 / 紫鸟登录 / 全部字段）拼装可直接粘贴的文本。
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { COPY_TEMPLATES, useShopAccountsStore } from '../store';
import IconGlyph from './IconGlyph.vue';
import type { ShopAccountItem } from '@/types';

const props = defineProps<{ item: ShopAccountItem }>();
const store = useShopAccountsStore();

const root = ref<HTMLElement | null>(null);
const open = ref(false);

function toggle(): void {
  open.value = !open.value;
}

function pick(templateId: string): void {
  open.value = false;
  void store.copyTemplate(props.item, templateId);
}

function onDocumentClick(event: MouseEvent): void {
  const el = root.value;
  if (el && !el.contains(event.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener('click', onDocumentClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick));
</script>

<template>
  <div ref="root" class="copy-menu">
    <button class="mini-btn" type="button" :title="'按模板复制'" @click.stop="toggle">
      <IconGlyph name="copy" :size="12" />
      <IconGlyph name="chevron-down" :size="10" />
    </button>
    <div v-if="open" class="copy-dropdown">
      <div class="copy-title">一键复制</div>
      <button
        v-for="t in COPY_TEMPLATES"
        :key="t.id"
        class="copy-item"
        type="button"
        @click.stop="pick(t.id)"
      >
        {{ t.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.copy-menu {
  position: relative;
  display: inline-flex;
}
.mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 1px;
  height: 22px;
  padding: 0 3px;
  border: 1px solid var(--wb-border);
  border-radius: 4px;
  background: var(--wb-surface);
  color: var(--wb-text-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.mini-btn:hover {
  color: var(--wb-primary);
  border-color: var(--wb-primary);
  background: var(--wb-primary-soft);
}
.copy-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 30;
  min-width: 132px;
  padding: 4px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  box-shadow: 0 8px 24px var(--wb-overlay);
}
.copy-title {
  padding: 4px 8px 2px;
  font-size: 11px;
  color: var(--wb-text-muted);
}
.copy-item {
  display: block;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--wb-text);
  font-size: 12.5px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.copy-item:hover {
  background: var(--wb-hover);
  color: var(--wb-primary);
}
</style>
