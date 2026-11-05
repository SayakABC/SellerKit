// 全局 toast 通知服务。
//
// 替代原来散落在各模块 store 内的私有 toasts 状态与 showToast 实现。
// 全局只维护一份 toasts 队列，由 core/components/ToastHost.vue 渲染。

import { ref } from 'vue';

export type ToastType = 'success' | 'error' | 'info';

/** 提示条上的一个动作（就地撤销 / 重新打开 …）。点了就把这条提示收掉。 */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  /** 可选动作。不带动作的提示与以前完全一致（纯信息、不可点）。 */
  action?: ToastAction;
}

const toasts = ref<ToastItem[]>([]);
let toastId = 0;

const TOAST_DURATION_MS = 2000;
/**
 * 带动作的提示停留更久：2 秒不够"读完一句话 + 决定要不要撤销"。
 * 这是**可撤销动作**（不是确认框），过期即视为接受默认结果，不阻塞任何流程。
 */
const TOAST_ACTION_DURATION_MS = 6000;

function push(
  message: string,
  type: ToastType,
  action: ToastAction | undefined,
  duration: number
): number {
  const id = ++toastId;
  toasts.value.push({ id, message, type, action });
  setTimeout(() => dismissToast(id), duration);
  return id;
}

/** 收掉一条提示（动作按钮点完 / 超时）。 */
export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

/**
 * 弹出一条通知。
 * 参数顺序与原 showToast(message, type) 保持一致，便于迁移替换。
 */
export function toast(message: string, type: ToastType = 'info'): void {
  push(message, type, undefined, TOAST_DURATION_MS);
}

/**
 * 弹出一条**带动作**的提示（例：「已标记为已处理 —— 撤销」）。
 *
 * 为什么不各自在页面里画一条：动作提示一旦各画各的，位置、层级、消失时机全不一致；
 * 而它出现的场景（划掉待办、删除一行）恰恰是用户最需要"我刚点的东西在哪"的时候。
 * 全局唯一一条队列还能避免"连点两次、两条撤销叠在一起"。
 */
export function toastAction(
  message: string,
  action: ToastAction,
  opts: { type?: ToastType; duration?: number } = {}
): number {
  return push(message, opts.type ?? 'info', action, opts.duration ?? TOAST_ACTION_DURATION_MS);
}

toast.success = (message: string) => toast(message, 'success');
toast.error = (message: string) => toast(message, 'error');
toast.info = (message: string) => toast(message, 'info');

/** 供 ToastHost 渲染使用的全局队列 */
export function useToasts() {
  return toasts;
}
