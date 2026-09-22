<script setup>
// src/SettingsView.vue — 「账号管家」设置页（宿主设置中心承载）。
//
// 2026-09-18 从 ShopAccountsView 的岛内「设置」页签整体迁移至此：
// 由 manifest.settings.entry → ./dist/settings.html 独立入口渲染，宿主设置中心以 iframe 岛加载。
// 面板本身未改动：安全设置（本机加密可用性 / 隐私模式）+ 邮件收件箱设置（同步 / 缓存 / 索引）。
// 与主视图同为受控桥访问（window.__sk），宿主的 capability 白名单与权限门一视同仁。

import { onMounted, ref } from 'vue';
import { BOOT_TIMEOUT_MS, isConnected, ready } from './bridge.js';
import SecuritySettings from './components/SecuritySettings.vue';
import MailSettingsPanel from './components/MailSettingsPanel.vue';
import ToastHost from './components/ToastHost.vue';

/** booting：等待桥握手；stalled：有桥但握手超时；offline：无宿主桥（脱离 SellerKit 直接打开产物） */
const phase = ref('booting');
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
  <div class="settings-root">
    <div v-if="phase === 'booting'" class="boot">正在连接宿主…</div>
    <div v-else-if="phase === 'offline'" class="boot">
      <strong>未检测到宿主桥（window.__sk）</strong>
      <p>该设置页由宿主设置中心加载，请从 SellerKit「设置 → 账号管家」进入。</p>
    </div>
    <div v-else-if="phase === 'stalled'" class="boot">
      <strong>等待宿主桥握手超时（{{ BOOT_TIMEOUT_MS / 1000 }}s）</strong>
      <p>宿主桥已注入，但未收到 boot 握手，设置项的主题令牌与数据调用都依赖它。</p>
      <button type="button" class="boot-retry" @click="handshake">重试</button>
    </div>
    <div v-else class="settings-page">
      <SecuritySettings />
      <!-- embedded=false：渲染卡片外壳，与 SecuritySettings 的 .panel 卡片统一观感 -->
      <MailSettingsPanel :embedded="false" />
    </div>
    <!-- 岛内 Toast 出口：设置面板的保存/失败提示落在本页内 -->
    <ToastHost />
  </div>
</template>

<style scoped>
.settings-root {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/*
 * 设置页布局契约（2026-09-18 修复样式错乱）：
 * 本容器是唯一滚动区（height:100% + overflow-y:auto + 统一 padding），
 * 子面板（SecuritySettings / MailSettingsPanel）一律自然高度、不自带滚动与留白。
 * 此前 settings-pane 只做 flex 列、把滚动交给子面板的 height:100%+overflow:auto，
 * 百分比高度在 flex 容器里坍缩为 0，导致安全设置面板「消失」、内容溢出重叠。
 */
.settings-page {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.boot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  box-sizing: border-box;
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
