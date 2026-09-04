// src/core/plugin/index.ts
// 插件体系入口（Phase 1 内建宿主侧；Phase 2 SDK + Host API；Phase 3 权限门 + 外置插件）。
// 使用方式（AppShell）：
//   const pm = createBuiltinPluginManager();
//   pm.sortedMetas / pm.activate(id) / pm.getActiveCommands()
//   pm.discoverExternal() → pm.activateStartupPlugins()   // Phase 3 外置插件
// 插件作者（模块开发者）：
//   import type { PluginContext, HostApi } from '@/core/plugin';
//   import { definePlugin } from '@/core/plugin';   // SDK 组合器（§8）
//   ctx.host.clipboard.writeText(...)                // Host API（§7，外置插件经权限门）

export type {
  PluginState,
  ActivationEvent,
  PluginSource,
  CapabilityId,
  PluginCapability,
  PluginManifest,
  ContributionType,
  Contribution,
  ViewContribSpec,
  CommandContribSpec,
  SettingContribSpec,
} from './types';

export type { Container, ServiceDefinition, Token } from './di';
export type { EventBus, EventHandler, EventMeta } from './eventBus';
export type { ContributionRegistry } from './contributions';
export { canTransition } from './lifecycle';

// SDK 形态（Phase 2，§7/§8）：HostApi / PluginContext / definePlugin
export type {
  HostApi,
  PluginContext,
  PluginLogger,
  PluginHttpOptions,
  DialogKind,
  DialogOptions,
  FilePayload,
  ContributionRegistrar,
  PluginKeyValueStorage,
  PluginLifecycle,
  PluginModule,
} from './sdk';
export { definePlugin } from './sdk';
// Host API 渲染层 trusted 实现（仅宿主侧引用；插件只消费 ctx.host，不直接调用）
export { createHostApi } from './host';

// 权限门（Phase 3）：纯内核判定 + 审计；宿主侧才引用 createGatedHostApi
export type {
  PermissionRequest,
  PermissionDecision,
  AuditEntry,
  PermissionGate,
} from './security';
export { createPermissionGate, matchUrlPattern, decidePermission } from './security';
export { createGatedHostApi, PluginPermissionError } from './gatedHost';

// 外置插件（Phase 3 发现/校验；Phase 4 入口求值在 Worker 沙箱内，见 ./sandbox）
export type { ExternalPluginDescriptor, ExternalDiscoverResult } from './externalLoader';
export { discoverExternalPlugins } from './externalLoader';
export { validateExternalManifest } from './externalManifest';

// Worker 沙箱（Phase 4）：宿主适配层专用（pluginManager 内部引用）；类型对外开放便于管理面板展示
export type { SandboxedPlugin, CreateSandboxPluginOptions } from './sandbox';

export { createContainer } from './di';
export { createEventBus, PluginEvents } from './eventBus';
export {
  createContributionRegistry,
  contributionId,
} from './contributions';

export type {
  BuiltinPluginManager,
  ActivationResult,
  PluginOverview,
} from './pluginManager';
export { createBuiltinPluginManager } from './pluginManager';
