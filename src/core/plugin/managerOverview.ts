// src/core/plugin/managerOverview.ts
// pluginManager 的「概览/审计」职责（R3-3 拆分产物）：PluginCenter 管理面板数据源 + 权限审计查询。
// 函数自 pluginManager 闭包原样搬移，行为零改动。

import type { PluginState, PluginSource } from './types';
import type { ManagerContext } from './managerContext';

/** 插件概览（管理面板/审计展示用） */
export interface PluginOverview {
  id: string;
  name: string;
  version: string;
  source: PluginSource;
  state: PluginState;
  description?: string;
  author?: string;
  /** 信任级别：0 = 内建 / 1 = 旧外置（主线程）/ 2 = 外置 Worker 沙箱 */
  trustLevel: 0 | 1 | 2;
  /** 形态细分：内建 extension/module；外置 UI 岛为 'ui'（外置 L2 Worker 插件不设此字段） */
  kind?: 'extension' | 'module' | 'ui';
  /** 已声明能力域（外置插件；内建为空 = Level 0 恒放行） */
  capabilities: string[];
}

export function createOverviewOps(ctx: ManagerContext): {
  overview: () => PluginOverview[];
} {
  /** 全部插件概览（管理面板数据源） */
  function overview(): PluginOverview[] {
    const rows: PluginOverview[] = [...ctx.records.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({
        id: r.id,
        name: r.manifest.displayName,
        version: r.manifest.version,
        source: r.source,
        state: r.state,
        trustLevel: r.trustLevel,
        ...(r.source === 'builtin' ? { kind: r.kind } : {}),
        ...(r.manifest.description ? { description: r.manifest.description } : {}),
        ...(r.manifest.author ? { author: r.manifest.author } : {}),
        capabilities: (r.manifest.capabilities ?? []).map((c) => c.id),
      }));
    // P2：UI 岛并入管理面板（kind:'ui' 供 PluginCenter 徽标/启停/卸载；state 为合成 loaded/disabled）
    for (const [id, island] of ctx.uiIslands) {
      rows.push({
        id,
        name: island.manifest.displayName ?? id,
        version: island.manifest.version,
        source: 'external',
        state: ctx.disabled.has(id) ? 'disabled' : 'loaded',
        trustLevel: 2,
        kind: 'ui',
        ...(island.manifest.description ? { description: island.manifest.description } : {}),
        ...(island.manifest.author ? { author: island.manifest.author } : {}),
        capabilities: (island.manifest.capabilities ?? []).map((c) => c.id),
      });
    }
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }

  return { overview };
}
