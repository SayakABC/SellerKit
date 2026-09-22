// src/core/plugin/managerOverview.ts
// pluginManager 的「概览/审计」职责（R3-3 拆分产物）：PluginCenter 管理面板数据源 + 权限审计查询。
// 函数自 pluginManager 闭包原样搬移，行为零改动。

import type { PluginState, PluginSource, PluginCapability } from './types';
import type { ManagerContext } from './managerContext';

/**
 * 把一条能力声明渲染成「人看得懂的权限摘要」（H-02 配套）。
 *
 * 背景：管理面板原先只显示 `db` 这样的能力 **id 标签**，而能力名字与实际权力差别很大——
 * `db` + 域 + op 名足以意味着"读写你磁盘上的任意文件"（详见 `db[excel-copy]` 的路径权限）。
 * 用户看不到域与动作，等于在不知情的情况下同意。这里把域/动作/命名空间/地址白名单展开，
 * 只做展示，不参与任何判定。
 */
function describeCapability(c: PluginCapability): string {
  const parts: string[] = [];
  if (c.domains?.length) parts.push(`域 ${c.domains.join('/')}`);
  if (c.actions?.length) {
    const head = c.actions.slice(0, 6).join('/');
    parts.push(c.actions.length > 6 ? `操作 ${head} 等 ${c.actions.length} 项` : `操作 ${head}`);
  }
  if (c.namespaces?.length) parts.push(`命名空间 ${c.namespaces.join('/')}`);
  if (c.allow?.length) parts.push(`${c.allow.length} 条地址白名单`);
  return parts.length ? `${c.id}（${parts.join('；')}）` : `${c.id}（未限定，该域全部动作）`;
}

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
  /**
   * 能力的**明细**（域 / 动作 / 命名空间 / 地址白名单），与 capabilities 一一对应（H-02 配套）。
   * 仅用于展示，让"同意"可判断；判定一律走 security.ts。
   */
  capabilityDetails?: string[];
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
        ...(r.manifest.capabilities?.length
          ? { capabilityDetails: r.manifest.capabilities.map(describeCapability) }
          : {}),
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
        ...(island.manifest.capabilities?.length
          ? { capabilityDetails: island.manifest.capabilities.map(describeCapability) }
          : {}),
      });
    }
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }

  return { overview };
}
