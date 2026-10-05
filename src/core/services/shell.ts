// src/core/services/shell.ts
// 外壳级全局事件（AppShell 监听、任意模块/组件可派发）——**事件名的唯一出处**。
//
// 为什么要有这个文件：这三个事件是"字符串协议"，派发方散在各模块里（曾 5 处各写一遍字面量）。
// 名字写错**不会报错**：`dispatchEvent` 只是没人接 —— 表现为"点了没反应"，排查要一路找到 AppShell
// 的监听处。收敛到这里之后，派发方只 import 函数，改名字只改一处。
//
// 监听端（别处新增监听时请对齐）：
//   · `AppShell.vue` onMounted 里的 open-settings / switch-module / reload-island 三个监听；
//   · 守卫：`tests/uiIslandBridgeLifecycle.spec.ts` 之类的接线测试看的是 AppShell 是否在监听。

/** 切到另一个模块（外壳会异步等目标模块挂载；`action`/`payload` 交给目标模块 onMounted 消费） */
export function switchModule(moduleId: string, action?: string, payload?: unknown): void {
  if (!moduleId) return;
  const detail: { moduleId: string; action?: string; payload?: unknown } = { moduleId };
  if (action) detail.action = action;
  if (payload !== undefined) detail.payload = payload;
  window.dispatchEvent(new CustomEvent('switch-module', { detail }));
}

/** 打开设置页（可定位到分类 / 二级页签；基础分类见 `SettingsModal.vue`，岛的设置是 `<id>:settings`） */
export function openSettings(category?: string, tab?: string): void {
  window.dispatchEvent(new CustomEvent('open-settings', { detail: { category, tab } }));
}

/** 让外壳重载"正在打开的那个 UI 岛"（装/更新插件后调用；不是当前这个岛时外壳静默忽略） */
export function reloadIsland(pluginId: string): void {
  window.dispatchEvent(new CustomEvent('reload-island', { detail: { pluginId } }));
}