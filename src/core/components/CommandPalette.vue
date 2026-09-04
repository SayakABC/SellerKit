<template>
  <transition name="palette-fade">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-[var(--wb-overlay)]"
      @click.self="$emit('close')"
    >
      <div
        class="w-[560px] max-w-[92vw] bg-[var(--wb-surface)] rounded-xl shadow-2xl border border-[var(--wb-border)] overflow-hidden"
      >
        <!-- 搜索框 -->
        <div class="flex items-center gap-2 px-4 h-12 border-b border-[var(--wb-border)]">
          <svg
            class="text-[var(--wb-text-muted)] flex-shrink-0"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            ref="inputEl"
            v-model="query"
            type="text"
            placeholder="搜索模块或命令…"
            class="flex-1 outline-none bg-transparent text-sm text-[var(--wb-text)] placeholder:text-[var(--wb-text-muted)]"
            @keydown="onKeydown"
          />
          <kbd class="text-[11px] text-[var(--wb-text-muted)] border border-[var(--wb-border)] rounded px-1.5 py-0.5">ESC</kbd>
        </div>

        <!-- 结果列表 -->
        <div class="max-h-[50vh] overflow-y-auto py-2">
          <template v-for="section in sections" :key="section.title">
            <div
              v-if="section.items.length"
              class="px-4 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--wb-text-muted)]"
            >
              {{ section.title }}
            </div>
            <button
              v-for="item in section.items"
              :key="item.key"
              :class="[
                'w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors',
                isActive(item)
                  ? 'bg-[var(--wb-primary-soft)] text-[var(--wb-primary)]'
                  : 'text-[var(--wb-text)] hover:bg-[var(--wb-hover)]',
              ]"
              @mouseenter="setActive(item)"
              @click="choose(item)"
            >
              <span
                class="w-5 h-5 flex items-center justify-center text-[var(--wb-text-muted)] flex-shrink-0"
                v-html="iconHtml(item.icon)"
              ></span>
              <span class="flex-1 truncate">{{ item.label }}</span>
              <span v-if="item.shortcut" class="text-[11px] text-[var(--wb-text-muted)]">{{ item.shortcut }}</span>
            </button>
          </template>
          <div v-if="!hasResults" class="px-4 py-6 text-center text-sm text-[var(--wb-text-muted)]">
            没有匹配的结果
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import type { ModuleMeta, ModuleCommand } from '../types';

const props = defineProps<{
  open: boolean;
  modules: ModuleMeta[];
  commands: ModuleCommand[];
  activeModuleId: string;
  /** Phase 3：已激活外置插件（后台贡献型，非当前视图插件）的命令，独立分区展示 */
  pluginCommands?: ModuleCommand[];
}>();

const emit = defineEmits<{
  close: [];
  'select-module': [id: string];
  'run-command': [cmd: ModuleCommand];
}>();

interface PaletteItem {
  key: string;
  label: string;
  icon?: string;
  shortcut?: string;
  section: string;
  moduleId?: string;
  command?: ModuleCommand;
}

const query = ref('');
const inputEl = ref<HTMLInputElement | null>(null);
const activeIndex = ref(0);

const moduleItems = computed<PaletteItem[]>(() =>
  props.modules.map((m) => ({
    key: `module:${m.id}`,
    label: `切换到 ${m.name}`,
    icon: m.icon || 'box',
    section: '模块',
    moduleId: m.id,
  })),
);

const commandItems = computed<PaletteItem[]>(() =>
  props.commands.map((c) => ({
    key: `cmd:${c.id}`,
    label: c.title,
    icon: 'sparkles',
    shortcut: c.shortcut,
    section: '当前模块命令',
    command: c,
  })),
);

// Phase 3：外置插件（后台贡献型）命令，独立分区展示（避免与当前模块命令混淆）
const pluginCommandItems = computed<PaletteItem[]>(() =>
  (props.pluginCommands ?? []).map((c) => ({
    key: `plugin:${c.id}`,
    label: c.title,
    icon: 'tool',
    shortcut: c.shortcut,
    section: '外置插件命令',
    command: c,
  })),
);

// 扁平列表（导航用）：先模块，后当前模块命令，再外置插件命令
const flatItems = computed<PaletteItem[]>(() => [
  ...moduleItems.value,
  ...commandItems.value,
  ...pluginCommandItems.value,
]);

// 分组（渲染用）
const sections = computed(() => [
  { title: '模块', items: moduleItems.value },
  { title: '当前模块命令', items: commandItems.value },
  { title: '外置插件命令', items: pluginCommandItems.value },
]);

const hasResults = computed(() => flatItems.value.length > 0);

function flatIndexOf(key: string): number {
  return flatItems.value.findIndex((it) => it.key === key);
}

function isActive(item: PaletteItem): boolean {
  return flatItems.value[activeIndex.value]?.key === item.key;
}

function setActive(item: PaletteItem) {
  const idx = flatIndexOf(item.key);
  if (idx >= 0) activeIndex.value = idx;
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      query.value = '';
      activeIndex.value = 0;
      nextTick(() => inputEl.value?.focus());
    }
  },
);

watch(flatItems, () => {
  if (activeIndex.value >= flatItems.value.length) activeIndex.value = 0;
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIndex.value = Math.min(activeIndex.value + 1, flatItems.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const item = flatItems.value[activeIndex.value];
    if (item) choose(item);
  }
}

function choose(item: PaletteItem) {
  if (item.moduleId) {
    emit('select-module', item.moduleId);
  } else if (item.command) {
    emit('run-command', item.command);
  }
  emit('close');
}

const iconMap: Record<string, string> = {
  table:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4h16v16H4z"/><path d="M4 9h16M9 9v11"/></svg>',
  tool:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 7a3 3 0 10-4 4l-6 6 2 2 6-6a3 3 0 004-4l-2 2-2-2 2-2z"/></svg>',
  box:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l8 4v6c0 4-3 7-8 8-5-1-8-4-8-8V7z"/></svg>',
  chart:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  sparkles:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></svg>',
  settings:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
};

function iconHtml(icon?: string): string {
  return iconMap[icon || ''] || iconMap.box;
}
</script>

<style scoped>
.palette-fade-enter-active,
.palette-fade-leave-active {
  transition: opacity 0.15s ease;
}
.palette-fade-enter-from,
.palette-fade-leave-to {
  opacity: 0;
}
</style>
