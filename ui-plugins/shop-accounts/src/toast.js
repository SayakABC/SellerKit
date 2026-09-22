// src/toast.js — 岛内 Toast 队列（自渲染，不依赖宿主 ui.notify）。
//
// 背景（2026-09-17 用户反馈）：列表点击复制后无任何提示。原实现走
// bridge.notify → 宿主 ui.notify RPC → 宿主 ToastHost，链路长且提示渲染在宿主层，
// 岛内无法保证可见性。改为岛内自渲染：api.js（@/core/services/toast 桩）统一走本队列，
// 由 components/ToastHost.vue 挂在岛根节点展示——复制成功/失败提示必然出现在岛内。

import { ref } from 'vue';

/** 单条提示存活时长（毫秒），与宿主 ToastHost 的 2000ms 观感一致 */
const TOAST_DURATION_MS = 2200;

/** 同屏最多条数（超出时挤掉最旧的） */
const MAX_VISIBLE = 4;

const toasts = ref([]);

let seq = 0;

/**
 * 弹出一条岛内提示。
 * @param {string} text 文案
 * @param {'success'|'error'|'info'} [kind] 语义类型（默认 info）
 */
export function pushToast(text, kind = 'info') {
  const id = ++seq;
  const item = { id, text: String(text), kind };
  toasts.value = [...toasts.value, item].slice(-MAX_VISIBLE);
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, TOAST_DURATION_MS);
  return id;
}

/** 供 ToastHost 渲染使用的岛内队列 */
export function useIslandToasts() {
  return toasts;
}
