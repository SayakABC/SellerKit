// src/core/plugin/managerSettings.ts
// pluginManager 的「设置面板贡献」职责（R3-3 拆分产物）：惰性加载启用插件包的设置面板入口。
// 函数自 pluginManager 闭包原样搬移，行为零改动。
//
// 2026-09-18 扩展：同时贡献 **UI 岛设置面板**（manifest.settings，§15）——
// 岛在 manifest 声明设置页入口后，宿主设置中心出现 `<pluginId>:settings` 分类，
// 内容区由 IslandSettingsPanel 以 iframe 岛承载（同一 __sk 受控桥 / capability 白名单）。

import type { SettingPanelDef, UiIslandSettingPanelDef } from './sdk';
import { settingsPanelLoaders } from '@/registry.generated';
import type { ManagerContext } from './managerContext';

export function createSettingsOps(ctx: ManagerContext): {
  ensureSettingPanelsLoaded: () => Promise<void>;
  getSettingCategories: () => SettingPanelDef[];
  getIslandSettingCategories: () => UiIslandSettingPanelDef[];
} {
  const settingsPanelsByPlugin = new Map<string, SettingPanelDef[]>();
  const settingsLoadedPlugins = new Set<string>();

  /** 惰性加载启用插件包的设置面板入口（幂等缓存；SettingsModal 打开时调用一次） */
  async function ensureSettingPanelsLoaded(): Promise<void> {
    const ids = Object.keys(settingsPanelLoaders);
    await Promise.all(
      ids.map(async (pid) => {
        if (settingsLoadedPlugins.has(pid) || ctx.disabled.has(pid)) return;
        settingsLoadedPlugins.add(pid);
        try {
          const mod = (await settingsPanelLoaders[pid]()) as {
            settingPanels?: SettingPanelDef[];
            default?: { settingPanels?: SettingPanelDef[] };
          };
          const panels = Array.isArray(mod?.settingPanels)
            ? mod.settingPanels
            : mod?.default?.settingPanels;
          if (Array.isArray(panels) && panels.length) settingsPanelsByPlugin.set(pid, panels);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`[plugin] 加载插件 "${pid}" 设置面板失败`, e);
        }
      }),
    );
  }

  /** 设置页分类（仅启用插件的面板；按 order 升序） */
  function getSettingCategories(): SettingPanelDef[] {
    const out: SettingPanelDef[] = [];
    for (const [pid, panels] of settingsPanelsByPlugin) {
      if (ctx.disabled.has(pid)) continue;
      out.push(...panels);
    }
    return out.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  /** UI 岛设置分类（仅已安装且启用、且 manifest 声明 settings.entry 的岛；按 order 升序） */
  function getIslandSettingCategories(): UiIslandSettingPanelDef[] {
    const out: UiIslandSettingPanelDef[] = [];
    for (const [pid, island] of ctx.uiIslands) {
      if (ctx.disabled.has(pid)) continue;
      const contrib = island.manifest.settings;
      if (!contrib?.entry) continue;
      out.push({
        categoryId: `${pid}:settings`,
        categoryName: contrib.displayName || island.manifest.displayName || island.manifest.name,
        icon: contrib.icon || 'box',
        order: contrib.order ?? 100,
        pluginId: pid,
        entry: contrib.entry,
      });
    }
    return out.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  return { ensureSettingPanelsLoaded, getSettingCategories, getIslandSettingCategories };
}
