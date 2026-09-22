<template>
  <div class="island-settings">
    <!-- 状态条：仅在未连接/加载失败时出现，正常时无视觉噪音 -->
    <div v-if="connState !== 'connected'" class="island-settings-bar">{{ statusText }}</div>
    <!-- iframe 运行时岛：sk-plugin:// 只读服务 + 宿主注入桥 runtime + 跨源隔离 -->
    <iframe
      ref="frame"
      class="island-settings-frame"
      :src="src"
      sandbox="allow-scripts allow-forms allow-same-origin"
      @load="onFrameLoad"
    />
  </div>
</template>

<script setup lang="ts">
// src/core/components/IslandSettingsPanel.vue
// UI 岛设置面板宿主容器（2026-09-18）：把「岛声明式设置贡献」（manifest.settings）承载进宿主设置中心。
// 与 UiIslandView 共用同一套桥（attachUiIslandBridge）：token 握手、能力过权限门 + 审计、
// --wb-* 主题注入跟随；差别仅在壳层——无工具条、无「返回/重新加载」按钮，直接铺满设置内容区。
// 生命周期跟随组件：卸载即 dispose 桥与主题观察器（设置中心关闭则桥释放）。

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { BuiltinPluginManager } from '@/core/plugin/pluginManager';
import { attachUiIslandBridge, type UiIslandBridge } from '@/core/plugin/uiBridgeHost';
import { onMailSyncEvent } from '@/core/services/ipc';

const props = defineProps<{
  pluginId: string;
  /** 设置页入口（manifest.settings.entry，岛目录相对路径，如 ./dist/settings.html） */
  entry: string;
  manager: BuiltinPluginManager;
}>();

const frame = ref<HTMLIFrameElement | null>(null);
const connState = ref<'idle' | 'connected'>('idle');
let bridge: UiIslandBridge | null = null;
let themeObserver: MutationObserver | null = null;
/** 主进程邮件同步事件 → 插件总线转发（岛内邮件设置面板订阅同一事件驱动状态展示） */
let offMailSync: (() => void) | null = null;

const runtime = computed(() => props.manager.getUiIslandRuntime(props.pluginId));
const src = computed(() => {
  const rel = props.entry.startsWith('./') ? props.entry.slice(2) : props.entry.replace(/^\/+/, '');
  return rel ? `sk-plugin://${props.pluginId}/${rel}` : '';
});

const statusText = computed(() =>
  runtime.value ? '正在连接岛设置面板…' : '未发现该 UI 岛的运行时（请确认已安装并启用）',
);

function attach(): void {
  if (bridge || !frame.value || !runtime.value) return;
  bridge = attachUiIslandBridge(frame.value, {
    pluginId: props.pluginId,
    manifest: runtime.value.manifest,
    hostApi: runtime.value.hostApi,
    bus: props.manager.bus,
    env: { isMac: /mac/i.test(navigator.platform), platform: navigator.platform },
    onBooted: () => {
      connState.value = 'connected';
    },
  });
}

function onFrameLoad(): void {
  attach();
}

onMounted(() => {
  attach();
  // 主题令牌跟随：宿主 data-theme 切换（含 system 自动）→ 重采 --wb-* 推送岛内
  themeObserver = new MutationObserver(() => bridge?.pushTheme());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  offMailSync = onMailSyncEvent((payload) => {
    void props.manager.bus.emit('mail-sync-event', payload);
  });
});

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  themeObserver = null;
  offMailSync?.();
  offMailSync = null;
  bridge?.dispose();
  bridge = null;
});
</script>

<style scoped>
.island-settings {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--wb-surface, #ffffff);
  color: var(--wb-text, #1c1c1e);
}
.island-settings-bar {
  flex-shrink: 0;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--wb-text-muted, #8e8e93);
  border-bottom: 1px solid var(--wb-border, #e5e5e3);
}
.island-settings-frame {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: none;
  background: transparent;
}
</style>
