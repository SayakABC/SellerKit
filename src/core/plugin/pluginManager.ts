// src/core/plugin/pluginManager.ts
// 宿主侧插件管理器（Phase 1：内建插件；Phase 2：ctx 注入；Phase 3：权限门 + 外置插件；Phase 4：Worker 沙箱）。
// 职责：
//  1. discover：从 registry.generated（构建期生成）发现内建插件 + 经 IPC 扫描 <userData>/plugins 发现外置插件；
//  2. activate/deactivate：统一生命周期（懒加载 → 注册贡献 → 构造/建立执行环境 → 状态迁移）；
//  3. 外置插件为"后台贡献型"（命令/设置，无视图）：在 Worker 沙箱内执行（Level 2），
//     能力判定仍走主线程权限门；激活后命令进 ⌘K 全局区；
//  4. 作为贡献点注册表/事件总线/DI 容器的持有者，向宿主 AppShell 暴露"单一数据源"。
// 说明：本文件是宿主适配层，允许引用业务宿主类型（ModuleMeta/ModuleDefinition）；
//       纯内核文件（types/di/eventBus/contributions/lifecycle/sdk/security）保持零业务依赖，后续整体平移 packages/core。

import {
  enabledModuleMetas,
  moduleViewLoaders,
  pluginPackageInfos,
  settingsPanelLoaders,
} from '@/registry.generated';
import type { ModuleCommand, ModuleDefinition, ModuleMeta } from '@/core/types';
import { pluginsOpenDir, pluginsUninstall as ipcUninstallPlugin } from '@/core/services/ipc';
import {
  type ContributionRegistry,
  contributionId,
  createContributionRegistry,
} from './contributions';
import { type Container, createContainer } from './di';
import { type EventBus, PluginEvents, createEventBus } from './eventBus';
import { type ExternalPluginDescriptor, discoverExternalPlugins } from './externalLoader';
import { createGatedHostApi } from './gatedHost';
import { createHostApi } from './host';
import { assertTransition } from './lifecycle';
import { createSandboxedPlugin, type SandboxedPlugin } from './sandbox';
import { createPermissionGate, type AuditEntry } from './security';
import type {
  ContributionRegistrar,
  PluginContext,
  PluginKeyValueStorage,
  PluginLogger,
  SettingPanelDef,
} from './sdk';
import {
  type CommandContribSpec,
  type ContributionType,
  type PluginManifest,
  type PluginSource,
  type PluginState,
  type SettingContribSpec,
  type ViewContribSpec,
} from './types';

/** 内建插件统一 manifest 版本（随宿主分发，无独立版本演进） */
const BUILTIN_VERSION = '1.0.0';
const HOST_ENGINE_VERSION = '1.0.0';

interface PluginRecord {
  id: string;
  manifest: PluginManifest;
  state: PluginState;
  /** 来源：内建（registry.generated）/ 外置（<userData>/plugins，权限门受限） */
  source: PluginSource;
  /** 内建细分：extensions/<id> 随宿主分发插件包（registry pluginPackageInfos 有元数据）/ src/modules 纯宿主模块（外置 record 无此字段） */
  kind?: 'extension' | 'module';
  /** 信任级别：0 = 内建随宿主分发（host 不过权限门）；1 = 旧外置（主线程受限）；2 = 外置 Worker 沙箱 */
  trustLevel: 0 | 1 | 2;
  /** 视图组件/命令/钩子来源（内建插件：懒加载，激活时才 import） */
  def: ModuleDefinition | null;
  /** 外置插件 Worker 沙箱句柄（激活时创建/缓存，停用或崩溃后销毁置空） */
  sandbox: SandboxedPlugin | null;
  /** 外置插件入口相对路径 */
  externalEntry?: string;
  /** 动态贡献的注销函数（activate 期间累积，deactivate 批量执行） */
  disposers: Array<() => void>;
  /** 当前激活会话的插件上下文（deactivate 时回收置空） */
  ctx: PluginContext | null;
  /** ctx 的中止控制器（deactivate 时 abort，通知插件释放长任务） */
  ctxAbort: AbortController | null;
}

/** 激活结果：视图组件 + 当前插件命令（AppShell 渲染与 ⌘K 数据源） */
export interface ActivationResult {
  view: unknown;
  commands: ModuleCommand[];
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
  /** 内建细分（外置插件无此字段）：extension = 随宿主分发插件包（extensions/）；module = 纯宿主模块（src/modules） */
  kind?: 'extension' | 'module';
  /** 已声明能力域（外置插件；内建为空 = Level 0 恒放行） */
  capabilities: string[];
}

export interface BuiltinPluginManager {
  /** 侧栏/⌘K 模块列表数据源（来自视图贡献注册表，已按 order 排序） */
  sortedMetas: ModuleMeta[];
  has(id: string): boolean;
  /** 统一激活（仅内建视图插件）：内部处理上一插件的停用（懒加载 + 贡献注册 + 业务钩子 + 状态机） */
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
  /** 扫描 <userData>/plugins（IPC），校验 manifest 后登记为外置插件记录（内建 id 冲突将被拒绝） */
  discoverExternal(): Promise<{ root: string; total: number; errors: Array<{ id: string; error: string }> }>;
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

/** 随宿主分发视图插件包的元数据（registry pluginPackageInfos：version/description/author） */
interface BuiltinPkgInfo {
  version?: string;
  description?: string;
  author?: string;
}

/** 由模块 meta 生成本阶段 manifest（内建静态贡献：视图）；扩展插件包附带 manifest.json 元数据 */
function createBuiltinManifest(meta: ModuleMeta, pkg?: BuiltinPkgInfo): PluginManifest {
  return {
    name: meta.id,
    displayName: meta.name,
    version: pkg?.version || BUILTIN_VERSION,
    engines: { sellerkit: HOST_ENGINE_VERSION },
    activationEvents: ['onStartup'],
    ...(pkg?.description ? { description: pkg.description } : {}),
    ...(pkg?.author ? { author: pkg.author } : {}),
    contributes: {
      views: [
        {
          id: 'main',
          title: meta.name,
          icon: meta.icon,
          order: meta.order,
          navHidden: meta.navHidden,
          container: 'host',
        },
      ],
    },
  };
}

export function createBuiltinPluginManager(): BuiltinPluginManager {
  const container: Container = createContainer();
  const bus: EventBus = createEventBus();
  const contributions: ContributionRegistry = createContributionRegistry();
  // 权限门单例：全插件共享（内建 Level 0 不过门；外置 Level 1 每次 host 调用过门并审计）
  const gate = createPermissionGate();
  const records = new Map<string, PluginRecord>();
  const stateListeners = new Set<(id: string, s: PluginState, prev: PluginState) => void>();
  let currentId = '';
  let currentView: unknown = null;

  // 系统级服务注册进 DI（供后续插件上下文 / 宿主按 token 取用）
  const BUS_TOKEN = Symbol('eventBus');
  const REGISTRY_TOKEN = Symbol('contributionRegistry');
  container.register({ token: BUS_TOKEN, useValue: bus });
  container.register({ token: REGISTRY_TOKEN, useValue: contributions });

  function setState(record: PluginRecord, next: PluginState): void {
    assertTransition(record.state, next);
    const prev = record.state;
    record.state = next;
    for (const h of [...stateListeners]) h(record.id, next, prev);
    void bus.emit(PluginEvents.StateChanged, { id: record.id, state: next, prev });
  }

  /** 注册内建插件的静态视图贡献（manifest.contributes.views[0]，侧栏/⌘K 模块入口激活前即可见） */
  function registerStaticView(record: PluginRecord): void {
    const spec = record.manifest.contributes?.views?.[0] as ViewContribSpec | undefined;
    if (!spec) return;
    contributions.register<ViewContribSpec>({
      type: 'views',
      plugin: record.id,
      id: contributionId(record.id, 'main'),
      spec,
    });
  }

  /** discover：从构建期注册表发现内建插件并注册静态视图贡献（随宿主分发视图插件经 extensions 根收录） */
  function discover(): void {
    for (const meta of enabledModuleMetas) {
      if (records.has(meta.id)) continue;
      const record: PluginRecord = {
        id: meta.id,
        manifest: createBuiltinManifest(meta, pluginPackageInfos[meta.id]),
        state: 'installed',
        source: 'builtin',
        kind: pluginPackageInfos[meta.id] ? 'extension' : 'module',
        trustLevel: 0,
        def: null,
        sandbox: null,
        disposers: [],
        ctx: null,
        ctxAbort: null,
      };
      records.set(meta.id, record);
      registerStaticView(record);
      setState(record, 'loaded');
    }
  }

  /** 侧栏/模块列表数据源：由视图贡献注册表派生（注册表为单一事实源） */
  function metasFromContributions(): ModuleMeta[] {
    return contributions
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

  /**
   * 由 record 构造插件上下文（对齐 PLUGIN_ARCHITECTURE §5.5/§7/§8）：
   * - host：渲染层 trusted 实现的宿主能力面（storage/clipboard/http/dialog/ui/env）；
   *   内建（Level 0）直接用 raw；外置（Level 1）包一层权限门代理（gatedHost.ts）——越权调用抛 PluginPermissionError 并写审计；
   * - storage：key 级命名空间存储（底层落 modules.<pluginId>，key 为对象字段），
   *   只读写插件自身命名空间（隔离即安全），因此绑定 raw host 不过权限门；
   * - log：带 [plugin:<id>] 前缀的日志器；
   * - contributions：自动拼接 <plugin>.<localId> 的动态贡献注册便捷层；
   * - abort：deactivate 时中止（释放长任务/定时器）。
   * 每个激活会话重建一次；ctx.trustLevel 与 record 对齐（0=内建可信 / 1=外置受限）。
   */
  function createPluginContext(record: PluginRecord): { ctx: PluginContext; abort: AbortController } {
    const rawHost = createHostApi();
    const abort = new AbortController();
    const storage: PluginKeyValueStorage = {
      async load<T>(key: string): Promise<T | undefined> {
        const data = await rawHost.storage.load<Record<string, unknown>>(record.id);
        if (data == null) return undefined;
        return data[key] as T | undefined;
      },
      async save<T>(key: string, value: T): Promise<void> {
        const data = (await rawHost.storage.load<Record<string, unknown>>(record.id)) ?? {};
        data[key] = value;
        await rawHost.storage.save(record.id, data);
      },
      async clear(): Promise<void> {
        await rawHost.storage.clear(record.id);
      },
    };
    const host = record.trustLevel >= 1 ? createGatedHostApi(rawHost, record.manifest, gate, record.id) : rawHost;
    const log: PluginLogger = {
      debug: (message: string, ...args: unknown[]) =>
        console.debug(`[plugin:${record.id}]`, message, ...args),
      info: (message: string, ...args: unknown[]) =>
        console.info(`[plugin:${record.id}]`, message, ...args),
      warn: (message: string, ...args: unknown[]) =>
        console.warn(`[plugin:${record.id}]`, message, ...args),
      error: (message: string, ...args: unknown[]) =>
        console.error(`[plugin:${record.id}]`, message, ...args),
    };
    const registrar: ContributionRegistrar = {
      register<T>(type: ContributionType, id: string, spec: T): () => void {
        return contributions.register<T>({
          type,
          plugin: record.id,
          id: contributionId(record.id, id),
          spec,
        });
      },
      registerCommand(spec: CommandContribSpec): () => void {
        return contributions.register<CommandContribSpec>({
          type: 'commands',
          plugin: record.id,
          id: contributionId(record.id, spec.id),
          spec,
        });
      },
      registerView(spec: ViewContribSpec): () => void {
        return contributions.register<ViewContribSpec>({
          type: 'views',
          plugin: record.id,
          id: contributionId(record.id, spec.id),
          spec,
        });
      },
      registerSetting(spec: SettingContribSpec): () => void {
        return contributions.register<SettingContribSpec>({
          type: 'settings',
          plugin: record.id,
          id: contributionId(record.id, spec.id),
          spec,
        });
      },
    };
    return {
      ctx: {
        manifest: record.manifest,
        // §9 分级模型：0 = 内建（随宿主分发，可信）；1 = 外置（权限门受限）
        trustLevel: record.trustLevel,
        bus,
        contributions: registrar,
        host,
        storage,
        log,
        abort: abort.signal,
      },
      abort,
    };
  }

  async function deactivateRecord(record: PluginRecord, reason?: string): Promise<void> {
    if (record.state !== 'active') return;
    setState(record, 'deactivating');
    try {
      if (record.source === 'external') {
        // 外置（Level 2 沙箱）：deactivate 钩子在 Worker 内执行；句柄自身带超时并销毁 Worker
        await record.sandbox?.deactivate(reason);
      } else {
        // 内建（Level 0）：ctx 注入停用钩子（active 状态必已构造 ctx）
        const ctx = record.ctx as PluginContext;
        await record.def?.deactivate?.(ctx);
      }
    } finally {
      // 无论业务停用钩子是否抛错，都必须释放动态贡献并回到 inactive（资源不悬挂）；
      // 业务钩子的异常沿 finally 继续向上传播，由调用方决定是否提示。
      for (const dispose of record.disposers.splice(0)) dispose();
      contributions.removeByPlugin(record.id);
      // 外置：销毁沙箱句柄（幂等；deactivate 内部已 terminate Worker）
      record.sandbox?.dispose();
      record.sandbox = null;
      // 内建：通知插件中止长任务并回收上下文（下次激活时重建）
      record.ctxAbort?.abort();
      record.ctxAbort = null;
      record.ctx = null;
      setState(record, 'inactive');
      void bus.emit(PluginEvents.Deactivated, { id: record.id, reason });
    }
  }

  /** 状态归一到可激活的 loaded（支持 inactive/error/disabled 后重试；installed→loaded 与 discover 一致） */
  function ensureLoadable(record: PluginRecord): void {
    if (record.state === 'loaded' || record.state === 'activating' || record.state === 'active') return;
    if (record.state === 'error' || record.state === 'disabled') setState(record, 'installed');
    if (record.state === 'installed' || record.state === 'inactive') setState(record, 'loaded');
  }

  async function activate(id: string): Promise<ActivationResult> {
    const record = records.get(id);
    if (!record) throw new Error(`plugin not discovered: ${id}`);
    if (disabled.has(id)) {
      throw new Error(`插件 "${id}" 已停用，请到「设置 → 插件」启用后再打开`);
    }
    if (record.source !== 'builtin') {
      throw new Error(`外置插件(${id})不提供视图，请使用 activateExternal 激活`);
    }

    // 已是当前活跃插件：幂等返回缓存
    if (currentId === id && currentView !== null && record.state === 'active') {
      return { view: currentView, commands: getActiveCommands() };
    }

    // 1) 停用上一个插件（切换语义与历史 activateCore 一致：先停后启）
    if (currentId && currentId !== id) {
      const prev = records.get(currentId);
      if (prev) await deactivateRecord(prev, `switch-to:${id}`);
      currentId = '';
      currentView = null;
    }

    // 1.5) 状态归一：从 inactive/error/disabled 恢复重激活（否则 activating 前置态非法）
    ensureLoadable(record);

    // 2) 懒加载定义（仅激活时才 import；ESM 缓存保证重复激活不重复执行模块代码）
    if (!record.def) {
      const mod = (await moduleViewLoaders[id]()) as any;
      record.def = (mod.default ?? mod) as ModuleDefinition;
    }

    // 3) 注册动态贡献：命令（进 ⌘K）
    setState(record, 'activating');
    for (const cmd of record.def.commands ?? []) {
      record.disposers.push(
        contributions.register<CommandContribSpec>({
          type: 'commands',
          plugin: id,
          id: contributionId(id, cmd.id),
          spec: {
            id: cmd.id,
            title: cmd.title,
            order: cmd.order,
            shortcut: cmd.shortcut,
            run: cmd.run,
          },
        }),
      );
    }

    // 4) 构造插件上下文（Host API + 命名空间存储 + 日志 + 贡献便捷层 + abort），
    //    注入激活钩子 → 完成状态迁移（SDK 优先，无参旧钩子形态兼容）
    const { ctx, abort } = createPluginContext(record);
    record.ctx = ctx;
    record.ctxAbort = abort;
    await record.def.activate?.(ctx);
    setState(record, 'active');
    currentId = id;
    currentView = record.def.view;
    void bus.emit(PluginEvents.Activated, { id });

    return { view: currentView, commands: getActiveCommands() };
  }

  function getActiveCommands(): ModuleCommand[] {
    if (!currentId) return [];
    const list = contributions.list<CommandContribSpec>('commands');
    const cmds = list
      .filter((c) => c.plugin === currentId)
      .map((c) => c.spec as ModuleCommand);
    const declared = records.get(currentId)?.def?.commands ?? [];
    if (cmds.length !== declared.length) {
      // 注册表为准并告警（防御性检查：数量应与声明一致）
      // eslint-disable-next-line no-console
      console.warn(`[plugin] command contribution mismatch for "${currentId}"`, {
        registry: cmds.length,
        declared: declared.length,
      });
    }
    // T8：⌘K 当前模块命令按 order 升序（缺省 0；同值保持注册序稳定）
    return [...cmds].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  async function deactivateCurrent(reason?: string): Promise<void> {
    if (!currentId) return;
    const record = records.get(currentId);
    currentId = '';
    currentView = null;
    if (record) await deactivateRecord(record, reason);
  }

  // ===================== 外置插件（Phase 3） =====================

  /** 登记一个校验通过的外置插件（manifest 来自文件，与内建记录字段对齐） */
  function registerExternal(p: ExternalPluginDescriptor): void {
    if (records.has(p.id)) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin] 外置插件 "${p.id}" 与既有插件冲突，已跳过（内建不可被覆盖）`);
      return;
    }
    const record: PluginRecord = {
      id: p.id,
      manifest: p.manifest,
      state: 'installed',
      source: 'external',
      trustLevel: 2,
      def: null,
      sandbox: null,
      externalEntry: p.entry,
      disposers: [],
      ctx: null,
      ctxAbort: null,
    };
    records.set(p.id, record);
    setState(record, 'loaded'); // 发现完成（无静态视图贡献；命令在激活时注册）
  }

  /** 扫描 <userData>/plugins 并登记（坏 manifest 不中断；返回错误清单供宿主提示） */
  async function discoverExternal(): Promise<{ root: string; total: number; errors: Array<{ id: string; error: string }> }> {
    const res = await discoverExternalPlugins();
    for (const p of res.plugins) registerExternal(p);
    return { root: res.root, total: res.plugins.length, errors: res.errors };
  }

  /** 激活外置插件（后台贡献型：不改 currentId/currentView；入口 JS 在 Worker 沙箱内求值执行） */
  async function activateExternal(id: string): Promise<void> {
    const record = records.get(id);
    if (!record || record.source !== 'external') throw new Error(`外置插件不存在: ${id}`);
    if (record.state === 'active') return;
    ensureLoadable(record);
    setState(record, 'activating');
    try {
      // Phase 4：外置插件执行从"主线程 Blob import"（与宿主同 realm，可直达 electronAPI/DOM）迁移到
      // Worker 沙箱（独立 realm，仅剩 postMessage 桥）；能力判定仍在主线程权限门内逐调用执行。
      if (!record.sandbox) {
        record.sandbox = await createSandboxedPlugin({
          pluginId: id,
          manifest: record.manifest,
          entry: record.externalEntry ?? './index.js',
          bus,
          contributions,
          gate,
          onCrash: (err) => handleSandboxCrash(record, err),
        });
      }
      await record.sandbox.activate();
      setState(record, 'active');
      void bus.emit(PluginEvents.Activated, { id });
    } catch (e) {
      // 激活失败：清掉可能已注册的贡献（register-command 先于 activated 送达）并销毁沙箱，
      // 落到 error（可经 ensureLoadable 重试）；错误上抛由调用方提示
      for (const dispose of record.disposers.splice(0)) dispose();
      contributions.removeByPlugin(record.id);
      record.sandbox?.dispose();
      record.sandbox = null;
      setState(record, 'error');
      throw e;
    }
  }

  /** Worker 运行时崩溃（非业务异常，如插件触发宿主终止/进程级错误）：active → 清理 → error（可重试） */
  function handleSandboxCrash(record: PluginRecord, err: Error): void {
    if (record.state !== 'active') return; // activating/deactivating 阶段的崩溃由对应 await 路径自行收敛
    // eslint-disable-next-line no-console
    console.error(`[plugin:${record.id}] 沙箱异常终止: ${err.message}`);
    setState(record, 'deactivating');
    for (const dispose of record.disposers.splice(0)) dispose();
    contributions.removeByPlugin(record.id);
    record.sandbox?.dispose();
    record.sandbox = null;
    record.ctxAbort?.abort();
    record.ctxAbort = null;
    record.ctx = null;
    setState(record, 'error'); // deactivating → error 合法；经 ensureLoadable 可回到 loaded 重试
  }

  /** 宿主启动后：激活 activationEvents 含 onStartup 的外置插件 */
  async function activateStartupPlugins(): Promise<{ activated: string[]; errors: Array<{ id: string; error: string }> }> {
    const result: { activated: string[]; errors: Array<{ id: string; error: string }> } = {
      activated: [],
      errors: [],
    };
    for (const record of records.values()) {
      if (record.source !== 'external') continue;
      if (!record.manifest.activationEvents.includes('onStartup')) continue;
      if (record.state === 'active') continue;
      try {
        await activateExternal(record.id);
        result.activated.push(record.id);
      } catch (e) {
        result.errors.push({
          id: record.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return result;
  }

  /** 卸载外置插件：停用（若活跃）→ 清贡献 → 删目录（IPC）→ 移除记录 */
  async function uninstallExternal(id: string): Promise<void> {
    const record = records.get(id);
    if (!record || record.source !== 'external') throw new Error(`外置插件不存在: ${id}`);
    if (record.state === 'active') {
      await deactivateRecord(record, 'uninstall');
    }
    contributions.removeByPlugin(id);
    records.delete(id);
    const r = await ipcUninstallPlugin(id);
    if (!r.success) throw new Error(r.error ?? '删除插件目录失败（插件已停用，可手动清理）');
  }

  /** 已激活"后台"插件（非当前视图插件）的命令 → ⌘K 全局区 */
  function getPluginCommands(): ModuleCommand[] {
    return contributions
      .list<CommandContribSpec>('commands')
      .filter((c) => c.plugin !== currentId && records.get(c.plugin)?.state === 'active')
      .map((c) => c.spec as ModuleCommand)
      // T8：⌘K 外置插件命令按 order 升序（缺省 0；同值保持注册序稳定）
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /** 全部插件概览（管理面板数据源） */
  function overview(): PluginOverview[] {
    return [...records.values()]
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
  }

  /** 权限门最近被拒绝的审计（新的在前） */
  function auditDenied(): AuditEntry[] {
    return gate.recentDenied();
  }

  // ===================== 随宿主分发视图插件：运行时按包启停 =====================
  /** 停用插件集合（经 applyDisabled/setPluginEnabled 维护；持久化由宿主 AppShell 负责） */
  const disabled = new Set<string>();

  /**
   * 停用/启用内建插件：
   * - 停用：active → 完整停用（deactivateRecord 释放动态贡献/ctx）；再移除静态视图贡献并落到 disabled；
   * - 启用：disabled → installed → loaded（ensureLoadable），再补静态视图贡献（侧栏/⌘K 恢复）。
   * 幂等；state 变更经 stateListeners 广播，宿主侧随之刷新侧栏/⌘K/设置分类并持久化。
   */
  async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    const record = records.get(id);
    if (!record || record.source !== 'builtin') return;
    if (enabled === !disabled.has(id)) return; // 幂等
    if (enabled) {
      disabled.delete(id);
      // 先补静态视图贡献再状态广播（disabled→installed 广播触发宿主侧栏刷新，须保证刷新时贡献已就位）
      registerStaticView(record);
      ensureLoadable(record); // disabled → installed → loaded
    } else {
      disabled.add(id);
      if (record.state === 'active') await deactivateRecord(record, 'disable');
      contributions.removeByPlugin(id); // 移除静态视图贡献（幂等）
      setState(record, 'disabled'); // loaded / inactive → disabled（转移表合法）
    }
  }

  /** 启动时批量应用持久化停用集（幂等；应在首次 activate 前调用，避免停用插件瞬时可见） */
  async function applyDisabled(ids: string[]): Promise<void> {
    const want = new Set(ids.filter((i) => records.get(i)?.source === 'builtin'));
    for (const record of [...records.values()]) {
      if (record.source !== 'builtin') continue;
      const target = want.has(record.id);
      if (target && !disabled.has(record.id)) await setPluginEnabled(record.id, false);
      else if (!target && disabled.has(record.id)) await setPluginEnabled(record.id, true);
    }
  }

  // ===================== 设置页分类面板贡献（注册式，SettingsModal 按贡献生成分类导航） =====================
  const settingsPanelsByPlugin = new Map<string, SettingPanelDef[]>();
  const settingsLoadedPlugins = new Set<string>();

  /** 惰性加载启用插件包的设置面板入口（幂等缓存；SettingsModal 打开时调用一次） */
  async function ensureSettingPanelsLoaded(): Promise<void> {
    const ids = Object.keys(settingsPanelLoaders);
    await Promise.all(
      ids.map(async (pid) => {
        if (settingsLoadedPlugins.has(pid) || disabled.has(pid)) return;
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
      if (disabled.has(pid)) continue;
      out.push(...panels);
    }
    return out.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  discover();

  return {
    // getter：每次访问从视图贡献注册表重算，停用/启用后可即时取到最新列表
    get sortedMetas(): ModuleMeta[] {
      return metasFromContributions();
    },
    has: (id: string): boolean => records.has(id),
    activate,
    deactivateCurrent,
    getState: (id: string): PluginState | undefined => records.get(id)?.state,
    getActiveCommands,
    onStateChange(handler) {
      stateListeners.add(handler);
      return () => {
        stateListeners.delete(handler);
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
    auditDenied,
    isEnabled: (id: string): boolean => !disabled.has(id),
    setPluginEnabled,
    getDisabledIds: (): string[] => [...disabled],
    applyDisabled,
    ensureSettingPanelsLoaded,
    getSettingCategories,
    container,
    bus,
    contributions,
  };
}
