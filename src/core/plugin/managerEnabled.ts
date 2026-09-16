// src/core/plugin/managerEnabled.ts
// pluginManager 的「启停」职责（R3-3 拆分产物）：内建插件与 UI 岛的运行时启停 + 启动批量应用。
// 函数自 pluginManager 闭包原样搬移，行为零改动（含状态广播时序：先补贡献再广播）。

import type { ManagerContext } from './managerContext';

export function createEnabledOps(ctx: ManagerContext): {
  setPluginEnabled: (id: string, enabled: boolean) => Promise<void>;
  applyDisabled: (ids: string[]) => Promise<void>;
} {
  /**
   * 停用/启用内建插件与 UI 岛（P2）：
   * - 内建停用：active → 完整停用（deactivateRecord 释放动态贡献/ctx）；再移除静态视图贡献并落到 disabled；
   * - 内建启用：disabled → installed → loaded（ensureLoadable），再补静态视图贡献（侧栏/⌘K 恢复）。
   * - UI 岛：无记录/贡献，直接增删停用集，合成 state 广播驱动宿主刷新侧栏并持久化。
   * 幂等；state 变更经 stateListeners 广播，宿主侧随之刷新侧栏/⌘K/设置分类并持久化。
   */
  async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    if (ctx.uiIslands.has(id)) {
      if (enabled === !ctx.disabled.has(id)) return; // 幂等
      if (enabled) {
        ctx.disabled.delete(id);
        ctx.notifyHostState(id, 'loaded', 'disabled');
      } else {
        ctx.disabled.add(id);
        // prev=active：若该岛正被显示（宿主 activeId === id），其回落逻辑据此触发
        ctx.notifyHostState(id, 'disabled', 'active');
      }
      return;
    }
    const record = ctx.records.get(id);
    if (!record || record.source !== 'builtin') return;
    if (enabled === !ctx.disabled.has(id)) return; // 幂等
    if (enabled) {
      ctx.disabled.delete(id);
      // 先补静态视图贡献再状态广播（disabled→installed 广播触发宿主侧栏刷新，须保证刷新时贡献已就位）
      ctx.registerStaticView(record);
      ctx.ensureLoadable(record); // disabled → installed → loaded
    } else {
      ctx.disabled.add(id);
      if (record.state === 'active') await ctx.deactivateRecord(record, 'disable');
      ctx.contributions.removeByPlugin(id); // 移除静态视图贡献（幂等）
      ctx.setState(record, 'disabled'); // loaded / inactive → disabled（转移表合法）
    }
  }

  /** 启动时批量应用持久化停用集（幂等；应在首次 activate 前调用，避免停用插件瞬时可见） */
  async function applyDisabled(ids: string[]): Promise<void> {
    const want = new Set(ids.filter((i) => ctx.records.get(i)?.source === 'builtin'));
    for (const record of [...ctx.records.values()]) {
      if (record.source !== 'builtin') continue;
      const target = want.has(record.id);
      if (target && !ctx.disabled.has(record.id)) await setPluginEnabled(record.id, false);
      else if (!target && ctx.disabled.has(record.id)) await setPluginEnabled(record.id, true);
    }
  }

  return { setPluginEnabled, applyDisabled };
}
