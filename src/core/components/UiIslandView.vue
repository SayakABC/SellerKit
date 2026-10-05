<template>
  <div class="ui-island">
    <!-- 岛工具条：返回 / 连接状态 / 重新加载（+ 默认收起的「诊断」，见 UX 审查 B1：业务页不该是调试台） -->
    <div class="ui-island-bar">
      <button class="wb-btn wb-btn--sm ui-island-btn" data-act="island-back" @click="emit('back')">
        ← 返回
      </button>
      <span class="ui-island-dot" :class="connState" />
      <button
        v-if="failed"
        class="ui-island-status is-link"
        data-act="island-retry"
        @click="reload"
      >
        {{ statusText }} —— 点此重试
      </button>
      <span v-else class="ui-island-status" data-act="island-status">{{ statusText }}</span>
      <span class="ui-island-spacer" />
      <button
        class="wb-btn wb-btn--sm ui-island-btn"
        data-act="island-diagnostics"
        :class="{ 'is-on': showDiag }"
        @click="showDiag = !showDiag"
      >
        诊断
      </button>
      <template v-if="showDiag">
        <button
          class="wb-btn wb-btn--sm ui-island-btn"
          data-act="island-ping"
          :disabled="!connected"
          @click="emit('ping')"
        >
          宿主→岛事件
        </button>
        <span class="ui-island-diag" data-act="island-id">{{ props.pluginId }}</span>
      </template>
      <button class="wb-btn wb-btn--sm ui-island-btn" data-act="island-reload" @click="reload">
        重新加载
      </button>
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
// UI 岛宿主视图（docs/architecture/PLUGIN_ARCHITECTURE.md §15 P1）：外置富 UI 插件（manifest.kind === 'ui'）的运行时视图容器。
// 职责：
//  1. 以 sk-plugin://<id>/<entry> 加载插件静态站点（iframe 跨源沙箱）；
//  2. 挂接宿主桥（uiBridgeHost.attachUiIslandBridge）——token 握手、能力调用过 gated hostApi（权限门+审计）、
//     bus 双向事件、日志、--wb-* 主题令牌注入；
//  3. 会话生命周期跟随组件（卸载即 dispose 桥与主题观察器）；宿主从岛切走时桥 abort 在途调用。
// 数据源：manager.getUiIslandRuntime(id)（gated hostApi + manifest）；bus 直接取 manager.bus。
// 注：本组件被 AppShell 以双通道渲染（activeIslandId 非空时替代 component :is=activeView）。

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BuiltinPluginManager } from '@/core/plugin/pluginManager';
import { attachUiIslandBridge, type UiIslandBridge } from '@/core/plugin/uiBridgeHost';
import { toast } from '@/core/services/toast';
import { onMailSyncEvent } from '@/core/services/ipc';

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
/** 「诊断」区（默认收起）：宿主→岛事件、插件 id 这类**开发者信息**不占业务页的常规位置 */
const showDiag = ref(false);
/**
 * 握手疑似失败：attach 后 `HANDSHAKE_PATIENCE_MS` 内没等到带 token 的回执 → 状态行变成可点的「点此重试」。
 * 为什么要宿主自己计时：握手失败在 message 层是**静默**的（origin/token 不匹配的消息不抛错、不打印），
 * 页面上只剩一个不变的灰点 —— 用户无从判断"在连"还是"连不上"（UX 审查 D1）。
 */
const failed = ref(false);
const HANDSHAKE_PATIENCE_MS = 8000;
let failTimer: ReturnType<typeof setTimeout> | null = null;
/** 当前桥绑定的插件 id；与 props.pluginId 不一致说明组件被复用到另一个岛（见 attach） */
let bridgePluginId = '';
let themeObserver: MutationObserver | null = null;
let offIslandEvents: (() => void) | null = null;
/** 主进程邮件同步事件 → 插件总线转发（岛内 mailStore 以此驱动同步进度；订阅者为空时无副作用） */
let offMailSync: (() => void) | null = null;

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

/** 状态行说人话（不出现"桥/握手/权限门"——那是实现名，不是用户的事） */
const statusText = computed(() => {
  if (!runtime.value) return '插件未就绪';
  if (connected.value) return '已连接';
  return failed.value ? '未能连接' : '正在连接…';
});

function clearFailTimer(): void {
  if (failTimer) {
    clearTimeout(failTimer);
    failTimer = null;
  }
}

/** 每次建/重建会话都重新计时；连上了就取消（onBooted） */
function armFailTimer(): void {
  clearFailTimer();
  failed.value = false;
  failTimer = setTimeout(() => {
    failTimer = null;
    if (!connected.value) failed.value = true;
  }, HANDSHAKE_PATIENCE_MS);
}

/**
 * 挂接宿主桥。**幂等但按岛区分**（2026-09-24 修）：
 *
 * 旧实现 `if (bridge.value) return` 只在"本组件实例一个岛用到底"的前提下成立。
 * 一旦组件实例被复用到另一个岛（宿主渲染位置相同、Vue 复用同类型组件；AppShell 现已加 `:key`
 * 从源头避免，这里再自保一层），旧桥会带着**上一个岛的 expectedOrigin 与 token** 继续服务：
 *   - 新岛的 `hello` 来自 `sk-plugin://<新岛>` → 被旧桥的 origin 校验丢弃；
 *   - 旧桥补发的 `boot` 以 `sk-plugin://<旧岛>` 为 targetOrigin → **静默丢弃**（postMessage 对
 *     targetOrigin 不匹配不抛错、不打印，这正是该故障长期查不出来的原因）；
 *   - 新岛永久停在「等待宿主桥握手」，若它把首屏渲染门控在 boot 之后，就是**一片空白**。
 * 故：桥的存活期必须与"当前岛"一致——换岛先拆后建。
 */
function attach(): void {
  if (!frame.value || !runtime.value) return;
  if (!src.value) return; // 入口未就绪（manifest.entry 迟到）→ 等 src 变化再挂，避免用 about:blank 建会话
  if (bridge.value && bridgePluginId === props.pluginId) return;
  if (bridge.value) {
    bridge.value.dispose();
    bridge.value = null;
    connState.value = 'idle';
  }
  bridgePluginId = props.pluginId;
  armFailTimer();
  const isMac = /mac/i.test(navigator.platform);
  bridge.value = attachUiIslandBridge(frame.value, {
    pluginId: props.pluginId,
    manifest: runtime.value.manifest,
    hostApi: runtime.value.hostApi,
    bus: props.manager.bus,
    env: { isMac, platform: navigator.platform },
    onBooted: () => {
      connState.value = 'connected';
      clearFailTimer();
      failed.value = false;
    },
  });
}

/**
 * iframe 导航到 sk-plugin:// 文档之前不建会话。
 *
 * 修（2026-09-22）：原来只在 `onMounted` 里 attach，而那一帧 `src` 可能还是空串
 * （运行时/manifest.entry 迟到）或 iframe 还停在 about:blank —— 彼时算出的 targetOrigin 是空串，
 * `postMessage(data,'')` 非法直接抛错并被吞掉，宿主侧 boot 永远发不出去，岛停在
 * 「等待宿主桥握手超时（8s）」。桥侧已按插件 id 兜底推 origin（见 uiBridgeHost.resolveExpectedOrigin），
 * 这里再从时序上收敛：等 DOM 更新（flush: 'post'）后 src 已落到 iframe 上再 attach。
 */
watch([() => frame.value, () => src.value], () => attach(), { flush: 'post' });

/** iframe 文档加载完成：runtime 已注入并可发 hello（宿主侧握手在 message 层自动完成） */
function onFrameLoad(): void {
  attach();
}

function reload(): void {
  connState.value = 'idle';
  bridge.value?.dispose();
  bridge.value = null;
  // 跨域 iframe 无法访问 location（SecurityError），用 src 重置触发重新加载
  if (frame.value) {
    const currentSrc = frame.value.src;
    frame.value.src = '';
    frame.value.src = currentSrc;
  }
  attach();
}

/** 供外壳按需重载（插件刚装/刚更新且**正是当前打开的岛**时；见 AppShell 的 `reload-island` 监听） */
defineExpose({ reload });

onMounted(() => {
  attach();
  // 主题令牌跟随：宿主 data-theme 切换（含 system 自动）→ 重采 --wb-* 推送岛内
  themeObserver = new MutationObserver(() => bridge.value?.pushTheme());
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  // iframe → host 事件落点演示：订阅本岛发布的事件（如 `<pluginId>:greet`）并以 Toast 展示
  offIslandEvents = props.manager.bus.on(`${props.pluginId}:*`, (payload, meta) => {
    const type = (meta as { eventType?: string } | undefined)?.eventType ?? `${props.pluginId}:*`;
    toast.info(`[${props.pluginId}] 发布事件 ${type}`);
  });
  // 岛无独立 IPC 通道：把主进程的邮件同步事件转发到插件总线，供岛内按需订阅（事件名 mail-sync-event）
  offMailSync = onMailSyncEvent((payload) => {
    void props.manager.bus.emit('mail-sync-event', payload);
  });
});

onBeforeUnmount(() => {
  clearFailTimer();
  themeObserver?.disconnect();
  themeObserver = null;
  offIslandEvents?.();
  offIslandEvents = null;
  offMailSync?.();
  offMailSync = null;
  bridge.value?.dispose();
  bridge.value = null;
  bridgePluginId = '';
});
</script>

<style scoped>
.ui-island {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--wb-bg, #f6f7f9);
  color: var(--wb-text, #1f2328);
}
.ui-island-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  flex-shrink: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--wb-border, #e8eaed);
  background: var(--wb-surface, #ffffff);
}
.ui-island-frame {
  flex: 1;
  border: none;
  min-height: 0;
  width: 100%;
  background: transparent;
}
/* 按钮基座来自全局 .wb-btn--sm；本页只留布局职责。
   原先这里自写一份 6px 圆角 / 12px 字的按钮，与宿主其它 8px 圆角的按钮不同源。 */
.ui-island-btn {
  flex-shrink: 0;
}
.ui-island-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  /* 未连接态：跟随主题的次要文字色（原先裸 hex，深色主题下偏亮） */
  background: var(--wb-text-muted, #666d79);
}
.ui-island-dot.connected {
  background: var(--wb-success, #15803d);
}
.ui-island-status {
  font-size: 12px;
  color: var(--wb-text-muted, #666d79);
  border: 0;
  background: transparent;
  padding: 2px 4px;
  font-family: inherit;
}
/* 失败态：状态行本身可点重试（比再放一个「重试」按钮少一个控件） */
.ui-island-status.is-link {
  color: var(--wb-warning, #b45309);
  text-decoration: underline;
  cursor: pointer;
}
.ui-island-diag {
  font-size: 12px;
  font-family: var(--wb-font-mono, ui-monospace, monospace);
  color: var(--wb-text-muted, #666d79);
}
.ui-island-spacer {
  flex: 1;
}
</style>
