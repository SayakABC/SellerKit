<template>
  <div class="ui-island">
    <!-- 岛工具条：返回 / 连接状态 / 重新加载（P1 形态：宿主双通道渲染的视图岛容器） -->
    <div class="ui-island-bar">
      <button class="ui-island-btn" @click="emit('back')">← 返回</button>
      <span class="ui-island-dot" :class="connState" />
      <span class="ui-island-status">{{ statusText }}</span>
      <span class="ui-island-spacer" />
      <button class="ui-island-btn" :disabled="!connected" @click="emit('ping')">宿主→岛事件</button>
      <button class="ui-island-btn" :disabled="!connected" @click="reload">重新加载</button>
    </div>
    <!-- iframe 运行时岛：sk-plugin:// 只读服务 + 宿主注入桥 runtime + 跨源隔离 -->
    <iframe
      ref="frame"
      class="ui-island-frame"
      :src="src"
      sandbox="allow-scripts allow-forms allow-same-origin"
      @load="onFrameLoad"
    />
  </div>
</template>

<script setup lang="ts">
// src/core/components/UiIslandView.vue
// UI 岛宿主视图（PLUGIN_ARCHITECTURE.md §15 P1）：外置富 UI 插件（manifest.kind === 'ui'）的运行时视图容器。
// 职责：
//  1. 以 sk-plugin://<id>/<entry> 加载插件静态站点（iframe 跨源沙箱）；
//  2. 挂接宿主桥（uiBridgeHost.attachUiIslandBridge）——token 握手、能力调用过 gated hostApi（权限门+审计）、
//     bus 双向事件、日志、--wb-* 主题令牌注入；
//  3. 会话生命周期跟随组件（卸载即 dispose 桥与主题观察器）；宿主从岛切走时桥 abort 在途调用。
// 数据源：manager.getUiIslandRuntime(id)（gated hostApi + manifest）；bus 直接取 manager.bus。
// 注：本组件被 AppShell 以双通道渲染（activeIslandId 非空时替代 component :is=activeView）。

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { BuiltinPluginManager } from '@/core/plugin/pluginManager';
import { attachUiIslandBridge, type UiIslandBridge } from '@/core/plugin/uiBridgeHost';
import { toast } from '@/core/services/toast';

const props = defineProps<{
  pluginId: string;
  manager: BuiltinPluginManager;
}>();

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'ping'): void;
}>();

const frame = ref<HTMLIFrameElement | null>(null);
const connState = ref<'idle' | 'connected'>('idle');
const bridge = ref<UiIslandBridge | null>(null);
let themeObserver: MutationObserver | null = null;
let offIslandEvents: (() => void) | null = null;

const runtime = computed(() => props.manager.getUiIslandRuntime(props.pluginId));
const manifest = computed(() => runtime.value?.manifest);
const connected = computed(() => connState.value === 'connected');

/** sk-plugin:// 地址：entry 为插件目录相对路径（manifest 约定 './dist/index.html'） */
const src = computed(() => {
  const entry = manifest.value?.entry;
  if (!entry) return '';
  const rel = entry.startsWith('./') ? entry.slice(2) : entry.replace(/^\/+/, '');
  return `sk-plugin://${props.pluginId}/${rel}`;
});

const statusText = computed(() => {
  if (!runtime.value) return '未发现 UI 岛运行时';
  return connected.value ? '桥已连接 · 越权调用由宿主权限门拒绝并审计' : '等待桥握手…';
});

function attach(): void {
  if (bridge.value || !frame.value || !runtime.value) return;
  const isMac = /mac/i.test(navigator.platform);
  bridge.value = attachUiIslandBridge(frame.value, {
    pluginId: props.pluginId,
    manifest: runtime.value.manifest,
    hostApi: runtime.value.hostApi,
    bus: props.manager.bus,
    env: { isMac, platform: navigator.platform },
    onBooted: () => {
      connState.value = 'connected';
    },
  });
}

/** iframe 文档加载完成：runtime 已注入并可发 hello（宿主侧握手在 message 层自动完成） */
function onFrameLoad(): void {
  attach();
}

function reload(): void {
  connState.value = 'idle';
  bridge.value?.dispose();
  bridge.value = null;
  const win = frame.value?.contentWindow;
  if (win) win.location.reload();
  else if (frame.value) frame.value.src = frame.value.src;
  attach();
}

onMounted(() => {
  attach();
  // 主题令牌跟随：宿主 data-theme 切换（含 system 自动）→ 重采 --wb-* 推送岛内
  themeObserver = new MutationObserver(() => bridge.value?.pushTheme());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  // iframe → host 事件落点演示：订阅本岛发布的事件（如 sk-ui-hello:greet）并以 Toast 展示
  offIslandEvents = props.manager.bus.on(`${props.pluginId}:*`, (payload, meta) => {
    const type = (meta as { eventType?: string } | undefined)?.eventType ?? `${props.pluginId}:*`;
    toast.info(`[${props.pluginId}] 发布事件 ${type}`);
  });
});

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  themeObserver = null;
  offIslandEvents?.();
  offIslandEvents = null;
  bridge.value?.dispose();
  bridge.value = null;
});
</script>

<style scoped>
.ui-island {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--wb-bg, #f7f7f5);
  color: var(--wb-text, #1c1c1e);
}
.ui-island-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  flex-shrink: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--wb-border, #e5e5e3);
  background: var(--wb-surface, #ffffff);
}
.ui-island-frame {
  flex: 1;
  border: none;
  min-height: 0;
  width: 100%;
  background: transparent;
}
.ui-island-btn {
  border: 1px solid var(--wb-border, #e5e5e3);
  border-radius: 6px;
  background: var(--wb-surface-2, #f2f2f0);
  color: var(--wb-text, #1c1c1e);
  font-size: 12px;
  padding: 3px 10px;
  cursor: pointer;
}
.ui-island-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.ui-island-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #9a9a96;
}
.ui-island-dot.connected {
  background: var(--wb-success, #34c759);
}
.ui-island-status {
  font-size: 12px;
  color: var(--wb-text-muted, #8e8e93);
}
.ui-island-spacer {
  flex: 1;
}
</style>
