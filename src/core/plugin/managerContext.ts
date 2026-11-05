// src/core/plugin/managerContext.ts
// pluginManager 的共享内核上下文（R3-3 拆分产物）。
// createBuiltinPluginManager 原为 683 行闭包，四职责（发现/激活/贡献/启停）共用同一批
// 可变状态与状态机原语。拆分方式：把状态与原语收进显式 ManagerContext，各职责文件
// 以 (ctx) 参数消费——**行为零改动**，仅把隐式闭包共享改为显式传递。
// 红线：本文件与 manager*.ts 不改任何语义（状态转移表、清理顺序、事件时序均原样保留）。

import type { ModuleDefinition } from '@/core/types';
import {
  createContributionRegistry,
  type ContributionRegistry,
  contributionId,
} from './contributions';
import { createContainer, type Container } from './di';
import { createEventBus, type EventBus, PluginEvents } from './eventBus';
import { createGatedHostApi } from './gatedHost';
import { createHostApi } from './host';
import { assertTransition } from './lifecycle';
import { createPermissionGate, type AuditEntry, type PermissionGate } from './security';
import type {
  CommandContribSpec,
  ContributionType,
  PluginManifest,
  PluginState,
  SettingContribSpec,
  ViewContribSpec,
} from './types';
import type { SandboxedPlugin } from './sandbox';
import type {
  ContributionRegistrar,
  HostApi,
  PluginContext,
  PluginKeyValueStorage,
  PluginLogger,
} from './sdk';

/** 宿主侧插件记录（内建 + 外置共用；UI 岛不进此表，见 UiIslandRecord） */
export interface PluginRecord {
  id: string;
  manifest: PluginManifest;
  state: PluginState;
  /** 来源：内建（registry.generated）/ 外置（<userData>/plugins，权限门受限） */
  source: 'builtin' | 'external';
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

/** §15 UI 岛记录：无 PluginRecord/贡献/Worker，仅 manifest + gated hostApi */
export interface UiIslandRecord {
  manifest: PluginManifest;
  /** 已过权限门的宿主能力面（createGatedHostApi 产物；越权拒绝 + 审计落同一 gate） */
  hostApi: HostApi;
}

export type StateHandler = (id: string, state: PluginState, prev: PluginState) => void;

/** 各 manager*.ts 职责文件共享的状态与状态机原语 */
export interface ManagerContext {
  container: Container;
  bus: EventBus;
  contributions: ContributionRegistry;
  gate: PermissionGate;
  records: Map<string, PluginRecord>;
  stateListeners: Set<StateHandler>;
  /** 当前视图插件（id + 缓存视图）；UI 岛激活时置空 */
  current: { id: string; view: unknown };
  /** 停用集合（内建 + UI 岛共用；宿主负责持久化） */
  disabled: Set<string>;
  uiIslands: Map<string, UiIslandRecord>;

  // ---- 状态机原语（原闭包内函数原样搬移） ----
  setState(record: PluginRecord, next: PluginState): void;
  notifyHostState(id: string, state: PluginState, prev: PluginState): void;
  registerStaticView(record: PluginRecord): void;
  ensureLoadable(record: PluginRecord): void;
  deactivateRecord(record: PluginRecord, reason?: string): Promise<void>;
  createPluginContext(record: PluginRecord): { ctx: PluginContext; abort: AbortController };
  /** 审计入口（权限门最近被拒绝，新的在前） */
  auditDenied(): AuditEntry[];
}

export function createManagerContext(): ManagerContext {
  const container: Container = createContainer();
  const bus: EventBus = createEventBus();
  const contributions: ContributionRegistry = createContributionRegistry();
  // 权限门单例：全插件共享（内建 Level 0 不过门；外置 Level 1 每次 host 调用过门并审计）
  const gate: PermissionGate = createPermissionGate();
  const records = new Map<string, PluginRecord>();
  const stateListeners = new Set<StateHandler>();
  const current: { id: string; view: unknown } = { id: '', view: null };
  const disabled = new Set<string>();
  const uiIslands = new Map<string, UiIslandRecord>();

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

  /**
   * 仅广播宿主状态监听（不产生 bus 事件）：UI 岛不在 records 里、无真实状态机，
   * 注册/启停/卸载时以合成状态通知宿主刷新侧栏/回落/持久化，沙箱插件不可感知。
   */
  function notifyHostState(id: string, state: PluginState, prev: PluginState): void {
    for (const h of [...stateListeners]) h(id, state, prev);
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

  /** 状态归一到可激活的 loaded（支持 inactive/error/disabled 后重试；installed→loaded 与 discover 一致） */
  function ensureLoadable(record: PluginRecord): void {
    if (record.state === 'loaded' || record.state === 'activating' || record.state === 'active') return;
    if (record.state === 'error' || record.state === 'disabled') setState(record, 'installed');
    if (record.state === 'installed' || record.state === 'inactive') setState(record, 'loaded');
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

  function auditDenied(): AuditEntry[] {
    return gate.recentDenied();
  }

  return {
    container,
    bus,
    contributions,
    gate,
    records,
    stateListeners,
    current,
    disabled,
    uiIslands,
    setState,
    notifyHostState,
    registerStaticView,
    ensureLoadable,
    deactivateRecord,
    createPluginContext,
    auditDenied,
  };
}
