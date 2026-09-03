<template>
  <div class="wb-titlebar" :class="{ 'wb-titlebar--mac': isMac }">
    <!-- 侧边栏展开/收起 -->
    <button
      class="wb-titlebar-btn mr-1"
      :title="collapsed ? '展开侧边栏' : '收起侧边栏'"
      @click="$emit('toggle')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>

    <!-- 业务流来源返回（switch-module 跨模块跳转后出现；模块内 Tab 切换不产生返回入口） -->
    <button
      v-if="backLabel"
      class="flex items-center gap-1 h-7 pl-1 pr-2.5 ml-1 rounded-lg text-xs font-medium text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)] transition-colors flex-shrink-0 max-w-[150px]"
      style="-webkit-app-region: no-drag"
      :title="`返回${backLabel}首页`"
      @click="$emit('back')"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="flex-shrink-0">
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
      <span class="truncate">{{ backLabel }}</span>
    </button>

    <!-- 当前模块名（WorkBuddy 标签式展示） -->
    <template v-if="moduleName">
      <span class="w-px h-3.5 bg-[var(--wb-border)] ml-1 flex-shrink-0"></span>
      <span class="text-xs text-[var(--wb-text-muted)] truncate ml-3">{{ moduleName }}</span>
    </template>

    <div class="wb-titlebar-spacer"></div>

    <!-- 命令面板入口（从 ContentHeader 合并而来） -->
    <button
      class="flex items-center gap-1.5 h-7 px-2.5 mr-1 rounded-lg text-xs text-[var(--wb-text-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)] transition-colors"
      style="-webkit-app-region: no-drag"
      title="命令面板"
      @click="$emit('open-palette')"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4-4" />
      </svg>
      <span>命令</span>
      <kbd class="text-[10px] border border-[var(--wb-border)] rounded px-1">⌘K</kbd>
    </button>

    <!-- 窗口控制：仅非 macOS 显示（macOS 用原生交通灯） -->
    <div v-if="!isMac" class="wb-titlebar-controls">
      <button class="wb-winbtn" title="最小化" @click="control('minimize')">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M2.5 6h7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
        </svg>
      </button>
      <button class="wb-winbtn" title="最大化" @click="control('maximize')">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
        </svg>
      </button>
      <button class="wb-winbtn wb-winbtn--close" title="关闭" @click="control('close')">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { isMac, controlWindow } from '../services/ipc';

defineProps<{ moduleName?: string; collapsed: boolean; backLabel?: string }>();
defineEmits<{ (e: 'toggle'): void; (e: 'open-palette'): void; (e: 'back'): void }>();

function control(action: 'minimize' | 'maximize' | 'close') {
  controlWindow(action);
}
</script>
