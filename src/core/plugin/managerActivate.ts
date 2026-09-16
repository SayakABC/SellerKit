// src/core/plugin/managerActivate.ts
// pluginManager 的「激活/生命周期」职责（R3-3 拆分产物）：
// 视图插件激活（懒加载 + 贡献注册 + 状态机）、外置 Worker 激活/崩溃、启动批量激活、
// 当前插件停用、⌘K 命令汇聚、外置卸载。全部函数自 pluginManager 闭包原样搬移，行为零改动。

import type { ModuleCommand, ModuleDefinition } from '@/core/types';
import { pluginsUninstall as ipcUninstallPlugin } from '@/core/services/ipc';
import { moduleViewLoaders } from '@/registry.generated';
import { contributionId } from './contributions';
import { PluginEvents } from './eventBus';
import { createSandboxedPlugin } from './sandbox';
import type { CommandContribSpec } from './types';
import type { ManagerContext, PluginRecord } from './managerContext';

/** 激活结果：视图组件 + 当前插件命令（AppShell 渲染与 ⌘K 数据源） */
export interface ActivationResult {
  view: unknown;
  commands: ModuleCommand[];
}

export function createActivateOps(ctx: ManagerContext): {
  activate: (id: string) => Promise<ActivationResult>;
  deactivateCurrent: (reason?: string) => Promise<void>;
  getActiveCommands: () => ModuleCommand[];
  activateExternal: (id: string) => Promise<void>;
  activateStartupPlugins: () => Promise<{ activated: string[]; errors: Array<{ id: string; error: string }> }>;
  uninstallExternal: (id: string) => Promise<void>;
  getPluginCommands: () => ModuleCommand[];
} {
  async function activate(id: string): Promise<ActivationResult> {
    // §15 UI 岛：独立轨道激活——不建 Worker/ctx，停上一视图插件后返回空视图（宿主双通道渲染 UiIslandView）
    if (ctx.uiIslands.has(id)) {
      if (ctx.disabled.has(id)) {
        throw new Error(`插件 "${id}" 已停用，请到「设置 → 插件」启用后再打开`);
      }
      if (ctx.current.id && ctx.current.id !== id) {
        const prev = ctx.records.get(ctx.current.id);
        if (prev) await ctx.deactivateRecord(prev, `switch-to:${id}`);
        ctx.current.id = '';
        ctx.current.view = null;
      }
      void ctx.bus.emit(PluginEvents.Activated, { id });
      return { view: null, commands: [] };
    }
    const record = ctx.records.get(id);
    if (!record) throw new Error(`plugin not discovered: ${id}`);
    if (ctx.disabled.has(id)) {
      throw new Error(`插件 "${id}" 已停用，请到「设置 → 插件」启用后再打开`);
    }
    if (record.source !== 'builtin') {
      throw new Error(`外置插件(${id})不提供视图，请使用 activateExternal 激活`);
    }

    // 已是当前活跃插件：幂等返回缓存
    if (ctx.current.id === id && ctx.current.view !== null && record.state === 'active') {
      return { view: ctx.current.view, commands: getActiveCommands() };
    }

    // 1) 停用上一个插件（切换语义与历史 activateCore 一致：先停后启）
    if (ctx.current.id && ctx.current.id !== id) {
      const prev = ctx.records.get(ctx.current.id);
      if (prev) await ctx.deactivateRecord(prev, `switch-to:${id}`);
      ctx.current.id = '';
      ctx.current.view = null;
    }

    // 1.5) 状态归一：从 inactive/error/disabled 恢复重激活（否则 activating 前置态非法）
    ctx.ensureLoadable(record);

    // 2) 懒加载定义（仅激活时才 import；ESM 缓存保证重复激活不重复执行模块代码）
    if (!record.def) {
      const mod = (await moduleViewLoaders[id]()) as any;
      record.def = (mod.default ?? mod) as ModuleDefinition;
    }

    // 3) 注册动态贡献：命令（进 ⌘K）
    ctx.setState(record, 'activating');
    for (const cmd of record.def.commands ?? []) {
      record.disposers.push(
        ctx.contributions.register<CommandContribSpec>({
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
    const { ctx: pluginCtx, abort } = ctx.createPluginContext(record);
    record.ctx = pluginCtx;
    record.ctxAbort = abort;
    await record.def.activate?.(pluginCtx);
    ctx.setState(record, 'active');
    ctx.current.id = id;
    ctx.current.view = record.def.view;
    void ctx.bus.emit(PluginEvents.Activated, { id });

    return { view: ctx.current.view, commands: getActiveCommands() };
  }

  function getActiveCommands(): ModuleCommand[] {
    if (!ctx.current.id) return [];
    const list = ctx.contributions.list<CommandContribSpec>('commands');
    const cmds = list
      .filter((c) => c.plugin === ctx.current.id)
      .map((c) => c.spec as ModuleCommand);
    const declared = ctx.records.get(ctx.current.id)?.def?.commands ?? [];
    if (cmds.length !== declared.length) {
      // 注册表为准并告警（防御性检查：数量应与声明一致）
      // eslint-disable-next-line no-console
      console.warn(`[plugin] command contribution mismatch for "${ctx.current.id}"`, {
        registry: cmds.length,
        declared: declared.length,
      });
    }
    // T8：⌘K 当前模块命令按 order 升序（缺省 0；同值保持注册序稳定）
    return [...cmds].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  async function deactivateCurrent(reason?: string): Promise<void> {
    if (!ctx.current.id) return;
    const record = ctx.records.get(ctx.current.id);
    ctx.current.id = '';
    ctx.current.view = null;
    if (record) await ctx.deactivateRecord(record, reason);
  }

  /** 激活外置插件（后台贡献型：不改 currentId/currentView；入口 JS 在 Worker 沙箱内求值执行） */
  async function activateExternal(id: string): Promise<void> {
    const record = ctx.records.get(id);
    if (!record || record.source !== 'external') throw new Error(`外置插件不存在: ${id}`);
    if (record.manifest.kind === 'ui') {
      throw new Error(`插件 "${id}" 为 UI 形态（§15 iframe 运行时岛），不能以 Worker 后台方式激活`);
    }
    if (record.state === 'active') return;
    ctx.ensureLoadable(record);
    ctx.setState(record, 'activating');
    try {
      // Phase 4：外置插件执行从"主线程 Blob import"（与宿主同 realm，可直达 electronAPI/DOM）迁移到
      // Worker 沙箱（独立 realm，仅剩 postMessage 桥）；能力判定仍在主线程权限门内逐调用执行。
      if (!record.sandbox) {
        record.sandbox = await createSandboxedPlugin({
          pluginId: id,
          manifest: record.manifest,
          entry: record.externalEntry ?? './index.js',
          bus: ctx.bus,
          contributions: ctx.contributions,
          gate: ctx.gate,
          onCrash: (err) => handleSandboxCrash(record, err),
        });
      }
      await record.sandbox.activate();
      ctx.setState(record, 'active');
      void ctx.bus.emit(PluginEvents.Activated, { id });
    } catch (e) {
      // 激活失败：清掉可能已注册的贡献（register-command 先于 activated 送达）并销毁沙箱，
      // 落到 error（可经 ensureLoadable 重试）；错误上抛由调用方提示
      for (const dispose of record.disposers.splice(0)) dispose();
      ctx.contributions.removeByPlugin(record.id);
      record.sandbox?.dispose();
      record.sandbox = null;
      ctx.setState(record, 'error');
      throw e;
    }
  }

  /** Worker 运行时崩溃（非业务异常，如插件触发宿主终止/进程级错误）：active → 清理 → error（可重试） */
  function handleSandboxCrash(record: PluginRecord, err: Error): void {
    if (record.state !== 'active') return; // activating/deactivating 阶段的崩溃由对应 await 路径自行收敛
    // eslint-disable-next-line no-console
    console.error(`[plugin:${record.id}] 沙箱异常终止: ${err.message}`);
    ctx.setState(record, 'deactivating');
    for (const dispose of record.disposers.splice(0)) dispose();
    ctx.contributions.removeByPlugin(record.id);
    record.sandbox?.dispose();
    record.sandbox = null;
    record.ctxAbort?.abort();
    record.ctxAbort = null;
    record.ctx = null;
    ctx.setState(record, 'error'); // deactivating → error 合法；经 ensureLoadable 可回到 loaded 重试
  }

  /** 宿主启动后：激活 activationEvents 含 onStartup 的外置插件 */
  async function activateStartupPlugins(): Promise<{ activated: string[]; errors: Array<{ id: string; error: string }> }> {
    const result: { activated: string[]; errors: Array<{ id: string; error: string }> } = {
      activated: [],
      errors: [],
    };
    for (const record of ctx.records.values()) {
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

  /** 卸载外置插件：停用（若活跃）→ 清贡献 → 删目录（IPC）→ 移除记录；UI 岛走独立分支（P2） */
  async function uninstallExternal(id: string): Promise<void> {
    const island = ctx.uiIslands.get(id);
    if (island) {
      // UI 形态岛：无 Worker/贡献/ctx——移除运行时登记与停用标记 → 删目录（IPC）；合成 inactive
      // 通知让宿主刷新侧栏，且若该岛正被显示（activeIslandId === id）则回落回其他入口。
      ctx.uiIslands.delete(id);
      ctx.disabled.delete(id);
      ctx.notifyHostState(id, 'inactive', 'active');
      const r = await ipcUninstallPlugin(id);
      if (!r.success) throw new Error(r.error ?? '删除插件目录失败（已从运行时移除，可手动清理）');
      return;
    }
    const record = ctx.records.get(id);
    if (!record || record.source !== 'external') throw new Error(`外置插件不存在: ${id}`);
    if (record.state === 'active') {
      await ctx.deactivateRecord(record, 'uninstall');
    }
    ctx.contributions.removeByPlugin(id);
    ctx.records.delete(id);
    const r = await ipcUninstallPlugin(id);
    if (!r.success) throw new Error(r.error ?? '删除插件目录失败（插件已停用，可手动清理）');
  }

  /** 已激活"后台"插件（非当前视图插件）的命令 → ⌘K 全局区 */
  function getPluginCommands(): ModuleCommand[] {
    return ctx.contributions
      .list<CommandContribSpec>('commands')
      .filter((c) => c.plugin !== ctx.current.id && ctx.records.get(c.plugin)?.state === 'active')
      .map((c) => c.spec as ModuleCommand)
      // T8：⌘K 外置插件命令按 order 升序（缺省 0；同值保持注册序稳定）
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  return {
    activate,
    deactivateCurrent,
    getActiveCommands,
    activateExternal,
    activateStartupPlugins,
    uninstallExternal,
    getPluginCommands,
  };
}
