// 全局 toast 通知服务。
//
// 替代原来散落在各模块 store 内的私有 toasts 状态与 showToast 实现。
// 全局只维护一份 toasts 队列，由 core/components/ToastHost.vue 渲染。

import { ref } from 'vue';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

const toasts = ref<ToastItem[]>([]);
let toastId = 0;

const TOAST_DURATION_MS = 2000;

/**
 * 弹出一条通知。
 * 参数顺序与原 showToast(message, type) 保持一致，便于迁移替换。
 */
export function toast(message: string, type: ToastType = 'info'): void {
  const id = ++toastId;
  toasts.value.push({ id, message, type });
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, TOAST_DURATION_MS);
}

toast.success = (message: string) => toast(message, 'success');
toast.error = (message: string) => toast(message, 'error');
toast.info = (message: string) => toast(message, 'info');

/** 供 ToastHost 渲染使用的全局队列 */
export function useToasts() {
  return toasts;
}
