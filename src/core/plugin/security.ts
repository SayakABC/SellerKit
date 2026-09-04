// src/core/plugin/security.ts
// 权限门内核（Phase 3，§9 分级模型外置插件的唯一授权入口；Phase 4 起外置为 Level 2 Worker 沙箱）。
// 职责：
//  1. 依据 manifest.capabilities 判定调用是否被允许（能力域/动作/命名空间/URL 前缀四级）；
//  2. 每次判定（放行与拒绝）都写入有界审计环，宿主可查询/展示（审计日志）。
// 约束：纯内核实现，不依赖 Vue / Electron / 业务类型；仅消费 plugin/types 的纯类型。
// 注：权限判定始终发生在宿主主线程（内建 Level 0 与外置 Level 2 Worker 沙箱共用此门）。

import type { CapabilityId, PluginCapability, PluginManifest } from './types';

/** 能力调用请求（由宿主 Host 封装层在每次方法调用时构造） */
export interface PermissionRequest {
  /** 请求的能力域 */
  capability: CapabilityId;
  /** 动作名（如 clipboard: write / dialog: openFile / storage: load） */
  action?: string;
  /** storage 命名空间（如 'app-shell'） */
  namespace?: string;
  /** http 请求 URL */
  url?: string;
}

/** 判定结果 */
export type PermissionDecision = { ok: true } | { ok: false; reason: string };

/** 审计日志条目 */
export interface AuditEntry {
  ts: number;
  pluginId: string;
  req: PermissionRequest;
  allowed: boolean;
  reason?: string;
}

/** 权限门：check 判定 + recent 查询审计（宿主内共享单例） */
export interface PermissionGate {
  check(pluginId: string, manifest: PluginManifest, req: PermissionRequest): PermissionDecision;
  /** 最近审计日志（新的在前） */
  recent(): AuditEntry[];
  /** 仅最近被拒绝的条目（管理面板展示用） */
  recentDenied(): AuditEntry[];
}

const CAPABILITY_LABEL: Record<CapabilityId, string> = {
  storage: 'storage',
  http: 'http',
  clipboard: 'clipboard',
  dialog: 'dialog',
};

/** URL 前缀匹配：支持尾部 * 通配（https://api.x.com/*），否则按字符串前缀匹配 */
export function matchUrlPattern(pattern: string, url: string): boolean {
  if (!url) return false;
  if (pattern.endsWith('*')) return url.startsWith(pattern.slice(0, -1));
  return url.startsWith(pattern);
}

/** 由 manifest.capabilities 中提取指定能力声明 */
function findCapability(manifest: PluginManifest, id: CapabilityId): PluginCapability | undefined {
  return manifest.capabilities?.find((c) => c.id === id);
}

/**
 * 判定函数（纯）：Level 1 外置插件的 manifest 能力声明 → 授权结果。
 * 规则（文档 §9.2）：
 *  - 未声明 capabilities / 未声明对应能力域 → 拒绝；
 *  - actions 声明后，请求动作必须命中；
 *  - storage 的 namespace：声明了 namespaces 则必须命中；未声明时默认仅放行插件自身命名空间；
 *  - http 的 allow：必须命中（空/缺省 = 禁止任何网络请求）。
 */
export function decidePermission(
  pluginId: string,
  manifest: PluginManifest,
  req: PermissionRequest,
): PermissionDecision {
  const cap = findCapability(manifest, req.capability);
  if (!cap) {
    return {
      ok: false,
      reason: `能力未声明: ${CAPABILITY_LABEL[req.capability]}（插件仅声明了 [${(manifest.capabilities ?? [])
        .map((c) => CAPABILITY_LABEL[c.id])
        .join(', ')}]）`,
    };
  }
  if (cap.actions && req.action && !cap.actions.includes(req.action)) {
    return { ok: false, reason: `动作越权: ${req.capability}.${req.action} 不在声明白名单 [${cap.actions.join(', ')}]` };
  }
  if (req.capability === 'storage') {
    if (req.namespace) {
      // 自身命名空间 modules.<pluginId> 恒放行（数据隔离基线）；其余须在白名单
      const ownNs = pluginId;
      if (req.namespace === ownNs) return { ok: true };
      if (cap.namespaces && !cap.namespaces.includes(req.namespace)) {
        return { ok: false, reason: `命名空间越权: modules.${req.namespace} 不在声明白名单 [${cap.namespaces.join(', ')}]` };
      }
    }
    return { ok: true };
  }
  if (req.capability === 'http') {
    if (!cap.allow || cap.allow.length === 0) {
      return { ok: false, reason: 'http 能力已声明但未声明任何 allow 前缀（禁止请求）' };
    }
    if (req.url && !cap.allow.some((p) => matchUrlPattern(p, req.url ?? ''))) {
      return { ok: false, reason: `URL 越权: ${req.url} 未命中声明前缀 [${cap.allow.join(', ')}]` };
    }
    return { ok: true };
  }
  return { ok: true };
}

/** 创建权限门：check 全量审计（放行 + 拒绝都入环），recent 新的在前 */
export function createPermissionGate(maxEntries = 200): PermissionGate {
  const ring: AuditEntry[] = [];
  return {
    check(pluginId, manifest, req) {
      const decision = decidePermission(pluginId, manifest, req);
      const entry: AuditEntry = {
        ts: Date.now(),
        pluginId,
        req,
        allowed: decision.ok,
        ...(decision.ok ? {} : { reason: decision.reason }),
      };
      ring.push(entry);
      if (ring.length > maxEntries) ring.shift();
      return decision;
    },
    recent: () => [...ring].reverse(),
    recentDenied: () => [...ring].reverse().filter((e) => !e.allowed),
  };
}
