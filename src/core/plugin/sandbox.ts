// src/core/plugin/sandbox.ts
// 外置插件 Worker 沙箱（Phase 4）宿主侧桥。
// 职责：
//  1. 经 IPC 读取插件入口源码（复用 pluginsReadEntry：主进程已完成路径/大小第一层防线）；
//  2. 将自包含运行时（sandboxRuntime.ts，?raw 文本）注入 Blob module worker —— 插件代码在
//     Worker 内求值执行，与宿主不共享 realm，无法直达 window.electronAPI / DOM / localStorage；
//  3. 桥协议：插件 ctx.host/storage/bus/contributions/log 全部经 postMessage 中继；
//     “能力判定”发生在主线程（gate.check → 越权抛 PluginPermissionError 并写审计环）；
//  4. token 校验：boot 建立一次性 token，此后所有消息（双向）校验 token，防 Worker 内伪造/串台；
//  5. 命令/事件中继：命令 run 闭环、总线订阅/发布、贡献注册/注销在 Worker 与注册表间转发。
// 约束：只依赖 core/services/ipc 与 plugin 内核；不引业务模块。

import { ipc, pluginsReadEntry } from '@/core/services/ipc';
import { contributionId } from './contributions';
import type { ContributionRegistry } from './contributions';
import type { EventBus } from './eventBus';
import { createGatedHostApi } from './gatedHost';
import { createHostApi } from './host';
import type { PermissionGate } from './security';
import type { CommandContribSpec, ContributionType, PluginManifest } from './types';
import runtimeSource from './sandboxRuntime.ts?raw';

// 消息名常量表 —— 必须与 sandboxRuntime.ts 顶部的 MSG 完全一致（改动需两处同步）
const MSG = {
  boot: 'boot',
  runCommand: 'run-command',
  event: 'event',
  deactivate: 'deactivate',
  abort: 'abort',
  activated: 'activated',
  bootError: 'boot-error',
  deactivated: 'deactivated',
  commandResult: 'command-result',
  call: 'call',
  callResult: 'call-result',
  log: 'log',
  registerCommand: 'register-command',
  unregisterCommand: 'unregister-command',
  registerContribution: 'register-contribution',
  unregisterContribution: 'unregister-contribution',
  subscribe: 'subscribe',
  unsubscribe: 'unsubscribe',
  publish: 'publish',
} as const;

/** 默认激活/停用钩子等待上限（超时即视为异常，进入清理路径） */
const ACTIVATE_TIMEOUT_MS = 30_000;
const DEACTIVATE_TIMEOUT_MS = 5_000;

export interface SerializedError {
  name: string;
  message: string;
}

/** 宿主 → Worker 请求的应答（Worker 回显 rid） */
interface WorkerReply {
  type: string;
  payload?: { rid?: number; ok?: boolean; error?: SerializedError; [k: string]: unknown };
}

export interface SandboxedPlugin {
  /** 启动 Worker 并运行插件 activate(ctx)；失败抛错（由调用方收敛状态） */
  activate(): Promise<void>;
  /** 请求插件执行 deactivate 钩子（带超时），随后销毁 Worker；钩子异常向上抛 */
  deactivate(reason?: string): Promise<void>;
  /** 幂等销毁：注销总线订阅 → 终止 Worker → 释放 URL */
  dispose(): void;
}

export interface CreateSandboxPluginOptions {
  pluginId: string;
  manifest: PluginManifest;
  /** 入口相对路径（已由主进程校验，禁止路径穿越） */
  entry: string;
  /** 宿主共享事件总线（订阅/发布经此桥接） */
  bus: EventBus;
  /** 宿主贡献点注册表（命令等贡献注册进此） */
  contributions: ContributionRegistry;
  /** 权限门单例（能力判定在主线程执行） */
  gate: PermissionGate;
  /** Worker 崩溃回调：激活完成后崩溃由宿主决定状态迁移（如 active → error） */
  onCrash?: (err: Error) => void;
  activateTimeoutMs?: number;
  deactivateTimeoutMs?: number;
}

function toSerializedError(e: unknown): SerializedError {
  const err = e as { name?: unknown; message?: unknown } | null;
  return {
    name: err && typeof err.name === 'string' ? err.name : 'Error',
    message: err && typeof err.message === 'string' ? err.message : String(e),
  };
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface BridgePayload {
  rid?: number;
  id?: unknown;
  ok?: boolean;
  value?: unknown;
  error?: SerializedError;
  domain?: string;
  method?: string;
  args?: unknown[];
  type?: string;
  subId?: string;
  payload?: unknown;
  meta?: unknown;
  level?: string;
  [k: string]: unknown;
}

/**
 * 创建外置插件的 Worker 沙箱宿主句柄。
 * 读取源码 → 起 Worker → 内部状态机；实际激活由调用方在合适的生命周期点触发 activate()。
 */
export async function createSandboxedPlugin(
  opts: CreateSandboxPluginOptions,
): Promise<SandboxedPlugin> {
  // 1) 读取入口源码（主进程第一道防线；这里只保证非空与基本形状）
  const codeR = await pluginsReadEntry(opts.pluginId, opts.entry);
  if (!codeR.success || !codeR.data) {
    throw new Error(`读取插件入口失败(${opts.pluginId}/${opts.entry}): ${codeR.error ?? 'IPC 错误'}`);
  }
  const source = codeR.data.code;
  if (!source.trim()) throw new Error(`插件入口为空(${opts.pluginId}/${opts.entry})`);

  // 2) 环境快照（版本经 IPC 等一次结果，避免 getter 滞后导致插件读到空版本）
  let version = '';
  try {
    const vr = await ipc.getAppVersion();
    if (vr.success && vr.data) version = vr.data;
  } catch {
    // 版本取不到不阻塞启动（插件一般不需要精确版本）
  }
  const env = { isMac: ipc.platform === 'darwin', platform: ipc.platform, version };

  // 3) 能力面：主线程 trusted 实现 + 权限门包装（判定/审计都在主线程，Worker 只转发调用意图）
  const gated = createGatedHostApi(createHostApi(), opts.manifest, opts.gate, opts.pluginId);

  const token = randomToken();
  const blobUrl = URL.createObjectURL(new Blob([runtimeSource], { type: 'text/javascript' }));
  const worker = new Worker(blobUrl, { type: 'module', name: `sk-sandbox:${opts.pluginId}` });

  let disposed = false;
  let ridSeq = 0;
  /** bus 订阅注销函数表（subId → off） */
  const busOffs = new Map<string, () => void>();
  /** 贡献注册表注销函数表（`${type}:${localId}` → dispose） */
  const localDisposers = new Map<string, () => void>();
  /** 宿主 → Worker 请求等待表（rid → resolver） */
  const outReqs = new Map<number, { resolve: (r: WorkerReply) => void; reject: (e: Error) => void }>();

  function post(type: string, payload: BridgePayload): void {
    if (disposed) return;
    try {
      worker.postMessage({ token, type, payload });
    } catch {
      // Worker 已终止等竞态：静默丢弃
    }
  }

  /** 宿主 → Worker 请求-应答（run-command/deactivate/boot 通用） */
  function request(type: string, payload: BridgePayload, timeoutMs: number): Promise<WorkerReply> {
    if (disposed) return Promise.reject(new Error('插件沙箱已销毁'));
    const rid = ++ridSeq;
    return new Promise<WorkerReply>((resolve, reject) => {
      let settled = false;
      // timeoutMs <= 0 表示不设超时（命令执行可能弹宿主对话框，时长由用户决定）
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              outReqs.delete(rid);
              reject(new Error(`插件沙箱请求超时: ${type}`));
            }, timeoutMs)
          : undefined;
      outReqs.set(rid, {
        resolve: (r) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      post(type, { ...payload, rid });
    });
  }

  function rejectAll(err: Error): void {
    for (const [, req] of outReqs) req.reject(err);
    outReqs.clear();
  }

  // ---------- Worker → 宿主 消息处理 ----------

  async function handleCall(p: BridgePayload): Promise<void> {
    try {
      // 能力判定在主线程：gated 为 raw host + 权限门包装（createGatedHostApi）
      const svc = (gated as unknown as Record<string, unknown>)[String(p.domain ?? '')] as
        | Record<string, unknown>
        | undefined;
      const fn = svc?.[String(p.method ?? '')];
      if (typeof fn !== 'function') {
        throw new Error(`宿主能力不存在: ${String(p.domain)}.${String(p.method)}`);
      }
      const value = await fn.apply(svc, Array.isArray(p.args) ? p.args : []);
      post(MSG.callResult, { id: p.id, ok: true, value });
    } catch (e) {
      post(MSG.callResult, { id: p.id, ok: false, error: toSerializedError(e) });
    }
  }

  function handleRegisterCommand(p: BridgePayload): void {
    const localId = String(p.id ?? '');
    if (!localId) return;
    const key = `commands:${localId}`;
    const spec: CommandContribSpec = {
      id: localId,
      title: String(p.title ?? localId),
      ...(typeof p.order === 'number' ? { order: p.order as number } : {}),
      ...(typeof p.shortcut === 'string' ? { shortcut: p.shortcut as string } : {}),
      run: async () => {
        const reply = await request(MSG.runCommand, { id: localId }, 0);
        if (!reply.payload?.ok) {
          const msg = reply.payload?.error?.message ?? '插件命令执行失败';
          const err = new Error(msg);
          err.name = reply.payload?.error?.name ?? 'PluginCommandError';
          throw err;
        }
      },
    };
    try {
      const dispose = opts.contributions.register<CommandContribSpec>({
        type: 'commands',
        plugin: opts.pluginId,
        id: contributionId(opts.pluginId, localId),
        spec,
      });
      localDisposers.set(key, dispose);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin:${opts.pluginId}] 命令贡献注册失败:`, toSerializedError(e).message);
    }
  }

  function handleRegisterContribution(p: BridgePayload): void {
    const type = String(p.type ?? '');
    const localId = String(p.id ?? '');
    if (!type || !localId) return;
    // 沙箱外置插件为后台贡献型：仅放行 settings 等"纯数据"贡献；
    // views/commands 已由 Worker 侧拒绝 + 宿主双保险（命令走 register-command 专用通道）
    if (type !== 'settings') {
      // eslint-disable-next-line no-console
      console.warn(`[plugin:${opts.pluginId}] 拒绝沙箱贡献类型 ${type}（仅支持 settings）`);
      return;
    }
    const ct: ContributionType = 'settings';
    const key = `${type}:${localId}`;
    try {
      const dispose = opts.contributions.register({
        type: ct,
        plugin: opts.pluginId,
        id: contributionId(opts.pluginId, localId),
        spec: p.spec as unknown,
      });
      localDisposers.set(key, dispose);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin:${opts.pluginId}] 贡献注册失败(${type}.${localId}):`, toSerializedError(e).message);
    }
  }

  function handleUnregister(p: BridgePayload): void {
    const type = String(p.type ?? 'commands');
    const localId = String(p.id ?? '');
    const key = `${type}:${localId}`;
    const dispose = localDisposers.get(key);
    if (dispose) {
      localDisposers.delete(key);
      dispose();
    }
  }

  function handleSubscribe(p: BridgePayload): void {
    const subId = String(p.subId ?? '');
    const type = String(p.type ?? '');
    if (!subId || !type || busOffs.has(subId)) return;
    // T9：转发实际事件名（meta.eventType，emit 时填充）——通配订阅下与订阅 pattern 不同，
    // Worker 端须按实际事件名本地路由
    const off = opts.bus.on(type, (payload, meta) => {
      void post(MSG.event, { type: meta.eventType ?? type, payload, meta });
    });
    busOffs.set(subId, off);
  }

  function handleUnsubscribe(p: BridgePayload): void {
    const subId = String(p.subId ?? '');
    const off = busOffs.get(subId);
    if (off) {
      busOffs.delete(subId);
      off();
    }
  }

  async function handlePublish(p: BridgePayload): Promise<void> {
    try {
      const meta = (p.meta ?? {}) as Record<string, unknown>;
      await opts.bus.emit(String(p.type ?? ''), p.payload, {
        sourcePlugin: opts.pluginId,
        origin: 'plugin',
        serialized: true,
        ...meta,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin:${opts.pluginId}] 事件发布失败:`, toSerializedError(e).message);
    }
  }

  function handleLog(p: BridgePayload): void {
    const level = String(p.level ?? 'info');
    const args = Array.isArray(p.args) ? p.args : [];
    const fn =
      level === 'debug' || level === 'warn' || level === 'error'
        ? (console as unknown as Record<string, unknown>)[level]
        : console.info;
    const logFn = typeof fn === 'function' ? (fn as (...a: unknown[]) => void) : console.info;
    logFn(`[plugin:${opts.pluginId}:sandbox]`, ...args);
  }

  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data as { token?: unknown; type?: unknown; payload?: BridgePayload } | null;
    if (!m || typeof m !== 'object' || m.token !== token) return; // 非本会话/伪造消息一律忽略
    const p = (m.payload ?? {}) as BridgePayload;
    switch (m.type) {
      case MSG.activated:
      case MSG.bootError:
      case MSG.deactivated:
      case MSG.commandResult: {
        const req = outReqs.get(Number(p.rid));
        if (!req) break;
        outReqs.delete(Number(p.rid));
        req.resolve({ type: String(m.type), payload: p });
        break;
      }
      case MSG.call:
        void handleCall(p);
        break;
      case MSG.registerCommand:
        handleRegisterCommand(p);
        break;
      case MSG.unregisterCommand:
        handleUnregister({ ...p, type: 'commands' });
        break;
      case MSG.registerContribution:
        handleRegisterContribution(p);
        break;
      case MSG.unregisterContribution:
        handleUnregister(p);
        break;
      case MSG.subscribe:
        handleSubscribe(p);
        break;
      case MSG.unsubscribe:
        handleUnsubscribe(p);
        break;
      case MSG.publish:
        void handlePublish(p);
        break;
      case MSG.log:
        handleLog(p);
        break;
      default:
        break;
    }
  };

  worker.onerror = (ev: ErrorEvent) => {
    if (disposed) return;
    const err = new Error(ev.message || '插件沙箱执行异常');
    rejectAll(err);
    opts.onCrash?.(err);
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const off of busOffs.values()) {
      try {
        off();
      } catch {
        // 单个订阅注销异常不阻塞清理
      }
    }
    busOffs.clear();
    localDisposers.clear();
    rejectAll(new Error('插件沙箱已销毁'));
    try {
      worker.terminate();
    } catch {
      // 已终止
    }
    URL.revokeObjectURL(blobUrl);
  }

  async function activate(): Promise<void> {
    if (disposed) throw new Error('插件沙箱已销毁，无法激活');
    const reply = await request(
      MSG.boot,
      { pluginId: opts.pluginId, manifest: opts.manifest, source, env },
      opts.activateTimeoutMs ?? ACTIVATE_TIMEOUT_MS,
    );
    if (reply.type === MSG.bootError) {
      const msg = reply.payload?.error?.message ?? '插件激活失败';
      const err = new Error(msg);
      err.name = reply.payload?.error?.name ?? 'PluginActivateError';
      throw err;
    }
    if (reply.type !== MSG.activated) {
      throw new Error('插件激活流程异常（未收到 activated 应答）');
    }
  }

  async function deactivate(reason?: string): Promise<void> {
    if (disposed) return;
    let hookError: SerializedError | undefined;
    try {
      const reply = await request(
        MSG.deactivate,
        { reason },
        opts.deactivateTimeoutMs ?? DEACTIVATE_TIMEOUT_MS,
      );
      if (reply.payload?.error) hookError = reply.payload.error as SerializedError;
    } catch (e) {
      // Worker 崩溃/超时：不再等待应答，直接进入销毁路径
      // eslint-disable-next-line no-console
      console.warn(
        `[plugin:${opts.pluginId}] deactivate 未获正常应答:`,
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      dispose();
    }
    if (hookError) {
      const err = new Error(hookError.message ?? '插件停用钩子异常');
      err.name = hookError.name ?? 'PluginDeactivateError';
      throw err;
    }
  }

  return { activate, deactivate, dispose };
}
