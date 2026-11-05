<script setup lang="ts">
// 行内「复制」菜单：预置模板（ERP 登录 / 紫鸟登录 / 店铺与账号）+ 本行已配置密码的
// 复制与临时查看（8 秒自动掩码）。2026-10-22 合并重设计后密码动作统一收进此菜单（方案 §3.2）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { COPY_TEMPLATES, SECRET_FIELDS, useShopAccountsStore } from '../store';
import IconGlyph from '@/core/components/IconGlyph.vue';
import type { ShopAccountItem } from '@/types';

const props = defineProps<{ item: ShopAccountItem }>();
const store = useShopAccountsStore();

const root = ref<HTMLElement | null>(null);
const open = ref(false);

/** 本行已配置的密码（未配置的不进菜单，避免一堆死项） */
const configuredSecrets = computed(() =>
  SECRET_FIELDS.filter((f) => props.item.secretKeys.includes(f.key)),
);

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
    <button class="mini-btn" type="button" :title="'复制 / 查看密码'" @click.stop="toggle">
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

      <template v-if="configuredSecrets.length">
        <div class="copy-title">密码（查看后 8 秒自动隐藏）</div>
        <div v-for="f in configuredSecrets" :key="f.key" class="secret-row">
          <span
            class="secret-row-label"
            :class="{ 'is-plain': store.isRevealed(item.id, f.key) }"
            :title="store.isRevealed(item.id, f.key) ? f.label : `${f.label}（点击眼睛查看）`"
          >
            {{ store.isRevealed(item.id, f.key) ? store.revealedValue(item.id, f.key) : f.label }}
          </span>
          <button
            class="mini-btn"
            type="button"
            :title="store.isRevealed(item.id, f.key) ? `隐藏${f.label}` : `临时查看${f.label}`"
            @click.stop="store.toggleReveal(item, f.key, f.label)"
          >
            <IconGlyph :name="store.isRevealed(item.id, f.key) ? 'eye-off' : 'eye'" :size="12" />
          </button>
          <button
            class="mini-btn"
            type="button"
            :title="`复制${f.label}`"
            @click.stop="store.copySecret(item, f.key, f.label)"
          >
            <IconGlyph name="copy" :size="12" />
          </button>
        </div>
      </template>
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
  min-width: 168px;
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
.secret-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 4px;
}
.secret-row:hover {
  background: var(--wb-hover);
}
.secret-row-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--wb-text);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.secret-row-label.is-plain {
  color: var(--wb-primary);
  font-weight: 600;
}
</style>
