// src/core/plugin/lifecycle.ts
// 插件生命周期状态机：显式状态转移表，非法转移抛错，避免状态漂移。
// 状态流转（Phase 1 内建插件会用到子集：installed → loaded → activating → active → inactive …）

import type { PluginState } from './types';

/** 合法转移表：from → to[] */
const TRANSITIONS: Record<PluginState, PluginState[]> = {
  installed: ['loaded', 'disabled', 'error'],
  loaded: ['activating', 'disabled', 'error'],
  activating: ['active', 'error'],
  active: ['deactivating'],
  deactivating: ['inactive', 'active', 'error'],
  inactive: ['loaded', 'uninstalled', 'disabled'],
  disabled: ['installed'],
  error: ['installed', 'disabled'],
  uninstalled: [],
};

export function canTransition(from: PluginState, to: PluginState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** 校验并执行转移；非法转移抛错（插件管理器内部使用，调用方应为宿主可信代码） */
export function assertTransition(from: PluginState, to: PluginState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal plugin state transition: ${from} -> ${to}`);
  }
}

export const PLUGIN_STATES: readonly PluginState[] = [
  'installed',
  'loaded',
  'activating',
  'active',
  'deactivating',
  'inactive',
  'disabled',
  'error',
  'uninstalled',
];
