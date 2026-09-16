// src/core/plugin/pluginManager.ts
// 宿主侧插件管理器——**门面**（R3-3 拆分后的组合层）。
// 职责划分（每职责一个 manager*.ts，共享状态与状态机原语在 managerContext.ts）：
//  1. managerContext   —— 共享状态（records/uiIslands/disabled/current）+ 状态机原语
//                         （setState / registerStaticView / ensureLoadable / deactivateRecord / createPluginContext）；
//  2. managerDiscover  —— 发现：内建注册表 + 外置 <userData>/plugins 扫描登记（含 UI 岛轨道）；
//  3. managerActivate  —— 激活/生命周期：视图插件、外置 Worker 沙箱、启动批量激活、崩溃收敛、卸载、⌘K 命令；
//  4. managerEnabled   —— 启停：setPluginEnabled / applyDisabled（内建 + UI 岛共用停用集）；
//  5. managerSettings  —— 设置页分类面板贡献的惰性加载；
//  6. managerOverview  —— PluginCenter 概览数据源。
// 本文件只做组合与门面暴露：**对外签名与拆分前完全一致**（BuiltinPluginManager /
// ActivationResult / PluginOverview / createBuiltinPluginManager），消费方
// （AppShell.vue / PluginCenter.vue / UiIslandView.vue / UI 岛桥）不受影响。
// 说明：本文件是宿主适配层，允许引用业务宿主类型（ModuleMeta/ModuleDefinition）；
//       纯内核文件（types/di/eventBus/contributions/lifecycle/sdk/security）保持零业务依赖，后续整体平移 packages/core。

import type { ModuleCommand, ModuleMeta } from '@/core/types';
import { pluginsOpenDir } from '@/core/services/ipc';
import type { ContributionRegistry } from './contributions';
import type { Container } from './di';
import type { EventBus } from './eventBus';
import type {
  CommandContribSpec,
  PluginManifest,
  PluginState,
  SettingContribSpec,
  ViewContribSpec,
} from './types';
import { createManagerContext, type ManagerContext, type StateHandler } from './managerContext';
import { createDiscoverOps } from './managerDiscover';
import { createActivateOps, type ActivationResult } from './managerActivate';
import { createEnabledOps } from './managerEnabled';
import { createSettingsOps } from './managerSettings';
import { createOverviewOps, type PluginOverview } from './managerOverview';
import type { AuditEntry } from './security';
import type { HostApi, SettingPanelDef } from './sdk';

export type { ActivationResult } from './managerActivate';
export type { PluginOverview } from './managerOverview';

export interface BuiltinPluginManager {
  /** 侧栏/⌘K 模块列表数据源（来自视图贡献注册表，已按 order 排序） */
  sortedMetas: ModuleMeta[];
  has(id: string): boolean;
  /** §15：id 是否为 UI 形态包（iframe 运行时岛；宿主双通道渲染，pm.activate 返回 view:null） */
  isUiIsland(id: string): boolean;
  /** §15：UI 岛运行时依赖（已过权限门的 gated hostApi + manifest），供宿主视图组件（UiIslandView）挂接桥 */
  getUiIslandRuntime(id: string): { manifest: PluginManifest; hostApi: HostApi } | undefined;
  /** 统一激活（仅内建视图插件与 UI 岛）：内部处理上一插件的停用（懒加载 + 贡献注册 + 业务钩子 + 状态机） */
  activate(id: string): Promise<ActivationResult>;
  /** 停用当前插件（activate 切换已自动处理；进程退出/测试清理时按需调用） */
  deactivateCurrent(reason?: string): Promise<void>;
  getState(id: string): PluginState | undefined;
  /** 当前活跃插件的命令（⌘K 当前模块区，来自命令贡献注册表） */
  getActiveCommands(): ModuleCommand[];
  /** 订阅插件状态变更（调试/审计） */
  onStateChange(handler: (id: string, state: PluginState, prev: PluginState) => void): () => void;
  container: Container;
  bus: EventBus;
  contributions: ContributionRegistry;
  // ---- 外置插件（Phase 3）：目录发现 / 懒激活 / 后台命令 / 卸载 / 审计 ----
  /** 扫描 <userData>/plugins（IPC），校验 manifest 后登记为外置插件记录与 UI 岛（内建 id 冲突将被拒绝） */
  discoverExternal(): Promise<{
    root: string;
    total: number;
    errors: Array<{ id: string; error: string }>;
    /** 发现的 UI 形态包（kind: 'ui'）数量——进独立轨道（uiIslands），不注册为 L2 Worker 插件 */
    uiCount: number;
  }>;
  /** 激活单个外置插件（不改变当前视图插件；入口 JS 懒加载并缓存） */
  activateExternal(id: string): Promise<void>;
  /** 激活 activationEvents 含 onStartup 的外置插件（宿主启动后调用） */
  activateStartupPlugins(): Promise<{ activated: string[]; errors: Array<{ id: string; error: string }> }>;
  /** 卸载外置插件：停用 + 清贡献 + 删除目录（IPC） */
  uninstallExternal(id: string): Promise<void>;
  /** 打开插件目录（系统文件管理器） */
  openPluginsDir(): Promise<string>;
  /** 已激活"后台"插件（非当前视图插件）的命令，合并进 ⌘K 全局区 */
  getPluginCommands(): ModuleCommand[];
  /** 全部插件概览（内建 + 外置，管理面板数据源） */
  overview(): PluginOverview[];
  /** 权限门最近被拒绝的审计条目（新的在前） */
  auditDenied(): AuditEntry[];
  // ---- 随宿主分发视图插件：运行时按包启停（mechanism A） ----
  /** 插件当前是否启用（停用后侧栏/⌘K/设置分类不出现且视图不可激活） */
  isEnabled(id: string): boolean;
  /** 停用/启用内建插件（active 插件停用会先完整停用；启用补注册静态视图贡献） */
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  /** 已停用插件 id 列表（宿主持久化用） */
  getDisabledIds(): string[];
  /** 启动时批量应用持久化停用集（幂等；应在首次 activate 前调用） */
  applyDisabled(ids: string[]): Promise<void>;
  // ---- 设置页分类面板贡献（注册式；SettingsModal 分类导航按贡献生成） ----
  /** 惰性加载所有启用插件包的设置面板入口（SettingsModal 打开时调用；幂等缓存） */
  ensureSettingPanelsLoaded(): Promise<void>;
  /** 设置页分类（过滤已停用插件；按 order 升序） */
  getSettingCategories(): SettingPanelDef[];
}

export function createBuiltinPluginManager(): BuiltinPluginManager {
  const ctx: ManagerContext = createManagerContext();

  // ---- 各职责装配（顺序敏感点：discover 需在门面返回前执行一次） ----
  const { discover, discoverExternal } = createDiscoverOps(ctx);
  const {
    activate,
    deactivateCurrent,
    getActiveCommands,
    activateExternal,
    activateStartupPlugins,
    uninstallExternal,
    getPluginCommands,
  } = createActivateOps(ctx);
  const { setPluginEnabled, applyDisabled } = createEnabledOps(ctx);
  const { ensureSettingPanelsLoaded, getSettingCategories } = createSettingsOps(ctx);
  const { overview } = createOverviewOps(ctx);

  /** 侧栏/模块列表数据源：由视图贡献注册表派生（注册表为单一事实源） */
  function metasFromContributions(): ModuleMeta[] {
    return ctx.contributions
      .list<ViewContribSpec>('views')
      .map((c) => ({
        id: c.plugin,
        name: c.spec.title,
        icon: c.spec.icon,
        order: c.spec.order,
        navHidden: c.spec.navHidden,
      }))
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  }

  discover();

  return {
    // getter：每次访问从视图贡献注册表重算，停用/启用后可即时取到最新列表；UI 岛追加在尾部（order 120）
    get sortedMetas(): ModuleMeta[] {
      const metas = metasFromContributions();
      for (const island of ctx.uiIslands.values()) {
        if (ctx.disabled.has(island.manifest.name)) continue; // P2：停用的岛不进侧栏/⌘K
        metas.push({
          id: island.manifest.name,
          name: island.manifest.displayName ?? island.manifest.name,
          icon: 'box',
          order: 120,
        });
      }
      return metas.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    },
    has: (id: string): boolean => ctx.records.has(id) || ctx.uiIslands.has(id),
    /** §15：id 是否为 UI 形态包（iframe 运行时岛） */
    isUiIsland: (id: string): boolean => ctx.uiIslands.has(id),
    /** §15：UI 岛运行时依赖（gated hostApi + manifest），供宿主视图组件挂接桥（UiIslandView） */
    getUiIslandRuntime: (id: string): { manifest: PluginManifest; hostApi: HostApi } | undefined => {
      const island = ctx.uiIslands.get(id);
      return island ? { manifest: island.manifest, hostApi: island.hostApi } : undefined;
    },
    activate,
    deactivateCurrent,
    getState: (id: string): PluginState | undefined => ctx.records.get(id)?.state,
    getActiveCommands,
    onStateChange(handler: StateHandler) {
      ctx.stateListeners.add(handler);
      return () => {
        ctx.stateListeners.delete(handler);
      };
    },
    discoverExternal,
    activateExternal,
    activateStartupPlugins,
    uninstallExternal,
    openPluginsDir: async (): Promise<string> => {
      const r = await pluginsOpenDir();
      if (!r.success) throw new Error(r.error ?? '打开插件目录失败');
      return r.data ?? '';
    },
    getPluginCommands,
    overview,
    auditDenied: () => ctx.auditDenied(),
    isEnabled: (id: string): boolean => !ctx.disabled.has(id),
    setPluginEnabled,
    getDisabledIds: (): string[] => [...ctx.disabled],
    applyDisabled,
    ensureSettingPanelsLoaded,
    getSettingCategories,
    container: ctx.container,
    bus: ctx.bus,
    contributions: ctx.contributions,
  };
}
