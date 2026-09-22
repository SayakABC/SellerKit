<script setup>
// 岛内 Toast 宿主：渲染 src/toast.js 的全局队列（复制成功/失败等操作反馈）。
// 固定于岛视口顶部居中，z-index 高于编辑抽屉（60），保证任何层级下都可见。
import { useIslandToasts } from '../toast.js';

const toasts = useIslandToasts();
</script>

<template>
  <div class="island-toast-host" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="island-toast" :class="`is-${t.kind}`">
        {{ t.text }}
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.island-toast-host {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}
.island-toast {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--wb-border);
  background: var(--wb-surface);
  color: var(--wb-text);
  font-size: 12.5px;
  line-height: 1.5;
  box-shadow: 0 6px 20px var(--wb-overlay);
  white-space: nowrap;
  max-width: 80vw;
  overflow: hidden;
  text-overflow: ellipsis;
}
.island-toast.is-success {
  border-color: var(--wb-success);
  color: var(--wb-success);
}
.island-toast.is-error {
  border-color: var(--wb-danger);
  color: var(--wb-danger);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
