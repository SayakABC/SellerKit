<script setup>
// src/App.vue — 岛外壳：等宿主桥 **完成 boot 握手** → 挂载主视图。
// 未连宿主（脱离 SellerKit 直接打开 dist）时给出明确说明，不做静默降级。
//
// 为什么必须等 boot 而不是等 "桥对象出现"：
//   --wb-* 主题令牌与业务调用都由 boot 之后才可用；若提前挂载主视图，
//   首屏会用 style.css 的浅色回退令牌（深色主题下与宿主观感不一致），
//   且首个数据调用挂在 boot 上，界面表现为永久「加载中」。
import { onMounted, ref } from 'vue';
import { BOOT_TIMEOUT_MS, isConnected, ready } from './bridge.js';
import ShopAccountsView from './ShopAccountsView.vue';
import ToastHost from './components/ToastHost.vue';

/** booting：等待桥握手；stalled：超时未握手（可能是宿主刚启动/iframe 被挂起）；offline：无宿主桥；ready：可渲染 */
const phase = ref('booting');
/** 是否有宿主桥（无桥 = 脱宿主打开，与"有桥但握手超时"是两种不同处置） */
const hasBridge = ref(false);

async function handshake() {
  phase.value = 'booting';
  hasBridge.value = !!window.__sk;
  const ok = await ready();
  if (ok && isConnected()) phase.value = 'ready';
  else phase.value = hasBridge.value ? 'stalled' : 'offline';
}

onMounted(() => {
  void handshake();
});
</script>

<template>
  <div class="island-root">
    <div v-if="phase === 'booting'" class="boot">正在连接宿主…</div>
    <div v-else-if="phase === 'offline'" class="boot">
      <strong>未检测到宿主桥（window.__sk）</strong>
      <p>请在 SellerKit 插件市场安装「店铺账号管家」后，从应用内侧栏打开。</p>
    </div>
    <div v-else-if="phase === 'stalled'" class="boot">
      <strong>等待宿主桥握手超时（{{ BOOT_TIMEOUT_MS / 1000 }}s）</strong>
      <p>宿主桥已注入，但未收到 boot 握手 —— 首屏主题令牌与数据调用都需要它。</p>
      <p class="boot-hint">常见于宿主刚启动或窗口刚恢复；点「重试」即可重新握手。</p>
      <button type="button" class="boot-retry" @click="handshake">重试</button>
    </div>
    <ShopAccountsView v-else />
    <!-- 岛内 Toast 渲染出口（复制/保存等操作提示必然出现在岛内） -->
    <ToastHost />
  </div>
</template>

<style scoped>
.island-root {
  height: 100%;
  min-height: 0;
}
.boot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  color: var(--wb-text-muted);
  font-size: 13px;
  text-align: center;
}
.boot strong {
  color: var(--wb-text);
  font-size: 14px;
}
.boot p {
  margin: 0;
}
.boot-hint {
  font-size: 12px;
  opacity: 0.85;
}
.boot-retry {
  margin-top: 8px;
  padding: 5px 16px;
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-surface, transparent);
  color: var(--wb-text);
  font-size: 12.5px;
  cursor: pointer;
}
.boot-retry:hover {
  border-color: var(--wb-primary);
}
</style>
