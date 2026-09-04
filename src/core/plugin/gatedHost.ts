// src/core/plugin/gatedHost.ts
// 权限门 Host 代理（Phase 3，§9.2）：Level 1+ 外置插件拿到的 ctx.host 是本代理，
// 每次调用都先过权限门（security.ts），被拒则抛 PluginPermissionError（可读原因）并已写入审计。
// 说明：
//  - ui/env 为轻量/只读能力，默认放行（透传）；
//  - storage/clipboard/http/dialog 按 manifest.capabilities 判定（见 decidePermission）。
// 约束：渲染层 trusted 实现，只包装 host.ts 的 createHostApi 产出，不引业务模块。

import type { DialogOptions, FilePayload, HostApi, PluginHttpOptions } from './sdk';
import type { PermissionGate, PermissionRequest } from './security';
import type { PluginManifest } from './types';

/** 权限被拒异常：message 含可读原因，供插件 try/catch 后提示用户 */
export class PluginPermissionError extends Error {
  readonly pluginId: string;
  readonly req: PermissionRequest;

  constructor(pluginId: string, req: PermissionRequest, reason: string) {
    super(`[插件 ${pluginId} 权限被拒] ${reason}`);
    this.name = 'PluginPermissionError';
    this.pluginId = pluginId;
    this.req = req;
  }
}

/** 把能力映射到权限门请求并放行/抛错 */
function guard(
  gate: PermissionGate,
  manifest: PluginManifest,
  pluginId: string,
  req: PermissionRequest,
): void {
  const r = gate.check(pluginId, manifest, req);
  if (!r.ok) throw new PluginPermissionError(pluginId, req, r.reason);
}

/**
 * 构造受权限门约束的 HostApi 代理。
 * @param raw     host.ts 的原始实现（渲染层 trusted）
 * @param manifest 插件 manifest（含 capabilities 声明）
 * @param gate    宿主侧共享权限门（审计环也由此持有）
 * @param pluginId 插件 id（恒等于 manifest.name，用于审计与自身命名空间判定）
 */
export function createGatedHostApi(
  raw: HostApi,
  manifest: PluginManifest,
  gate: PermissionGate,
  pluginId: string,
): HostApi {
  return {
    storage: {
      load<T = unknown>(ns: string): Promise<T | undefined> {
        guard(gate, manifest, pluginId, { capability: 'storage', action: 'load', namespace: ns });
        return raw.storage.load<T>(ns);
      },
      save<T>(ns: string, v: T): Promise<void> {
        guard(gate, manifest, pluginId, { capability: 'storage', action: 'save', namespace: ns });
        return raw.storage.save(ns, v);
      },
      clear(ns: string): Promise<void> {
        guard(gate, manifest, pluginId, { capability: 'storage', action: 'clear', namespace: ns });
        return raw.storage.clear(ns);
      },
    },
    clipboard: {
      writeText(text: string): Promise<void> {
        guard(gate, manifest, pluginId, { capability: 'clipboard', action: 'write' });
        return raw.clipboard.writeText(text);
      },
    },
    http: {
      get<T = unknown>(url: string, opts?: PluginHttpOptions): Promise<T> {
        guard(gate, manifest, pluginId, { capability: 'http', action: 'get', url });
        return raw.http.get<T>(url, opts);
      },
      post<T = unknown>(url: string, body?: unknown, opts?: PluginHttpOptions): Promise<T> {
        guard(gate, manifest, pluginId, { capability: 'http', action: 'post', url });
        return raw.http.post<T>(url, body, opts);
      },
    },
    dialog: {
      openFile(opts: DialogOptions): Promise<FilePayload | null> {
        guard(gate, manifest, pluginId, { capability: 'dialog', action: 'openFile' });
        return raw.dialog.openFile(opts);
      },
    },
    // ui / env：轻量只读，默认放行
    ui: raw.ui,
    env: raw.env,
  };
}
