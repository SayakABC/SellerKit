// src/core/plugin/externalManifest.ts
// 外置插件 manifest.json 校验与归一化（渲染层）。
// 说明：主进程 plugins-handlers 只做轻量形状检查（防路径穿越/坏 JSON），
//       完整 schema 校验在渲染层这里执行；两处互为纵深防御。
// 约束：纯函数，仅依赖 plugin/types；后续 schema 可平移 packages/sdk 复用。

import type {
  ActivationEvent,
  CapabilityId,
  PluginCapability,
  PluginManifest,
} from './types';

export type ManifestValidationResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string };

const CAPABILITIES: readonly CapabilityId[] = ['storage', 'http', 'clipboard', 'dialog'];
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** 字符串数组白名单校验：元素非空、长度受限、条数受限 */
function checkStrArray(v: unknown, maxLen: number, maxCount: number, label: string): string | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return `${label} 必须是字符串数组`;
  if (v.length > maxCount) return `${label} 条数超限（≤${maxCount}）`;
  for (const item of v) {
    if (!isStr(item) || !item.trim() || item.length > maxLen) {
      return `${label} 含非法元素（须为非空字符串，长度≤${maxLen}）`;
    }
  }
  return null;
}

/** 校验并归一化 manifest.json（entry 缺省 ./index.js；未知字段忽略，未来版本兼容） */
export function validateExternalManifest(raw: unknown): ManifestValidationResult {
  if (!isPlainObj(raw)) return { ok: false, error: 'manifest 顶层必须是 JSON 对象' };

  const name = raw.name;
  if (!isStr(name) || !ID_RE.test(name) || name.length > 64) {
    return { ok: false, error: 'manifest.name 缺失或非法（kebab-case，≤64 字符）' };
  }
  const displayName = isStr(raw.displayName) ? raw.displayName.slice(0, 64) : name;
  const version = isStr(raw.version) ? raw.version : '0.0.0';
  if (!VERSION_RE.test(version)) return { ok: false, error: 'manifest.version 非法（须 x.y.z）' };

  const engines = isPlainObj(raw.engines) ? raw.engines : {};
  if (!isStr(engines.sellerkit)) return { ok: false, error: 'manifest.engines.sellerkit 缺失（须为版本范围字符串）' };

  // 入口文件：仅允许相对路径（./index.js），禁止绝对路径/穿越
  const entry = isStr(raw.entry) && raw.entry.trim() ? raw.entry.trim() : './index.js';
  if (!entry.startsWith('./') || entry.includes('..')) {
    return { ok: false, error: `manifest.entry 非法（须为 ./ 开头的相对路径）: ${entry}` };
  }

  // 懒激活事件：白名单识别（onStartup / onCommand:xxx ...）；其余忽略不影响加载
  const activationEvents: ActivationEvent[] = Array.isArray(raw.activationEvents)
    ? raw.activationEvents.filter(isStr).slice(0, 16).filter((e) => e === 'onStartup') as ActivationEvent[]
    : [];

  // 能力声明：结构校验 + 上限约束
  const capabilities: PluginCapability[] = [];
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities) || raw.capabilities.length > 16) {
      return { ok: false, error: 'manifest.capabilities 必须是数组（≤16 项）' };
    }
    for (const c of raw.capabilities) {
      if (!isPlainObj(c)) return { ok: false, error: 'capabilities 元素必须是对象' };
      if (!isStr(c.id) || !CAPABILITIES.includes(c.id as CapabilityId)) {
        return { ok: false, error: `capabilities.id 非法（允许: ${CAPABILITIES.join('/')}）` };
      }
      const id = c.id as CapabilityId;
      const actionsErr = checkStrArray(c.actions, 64, 32, `capabilities.${id}.actions`);
      if (actionsErr) return { ok: false, error: actionsErr };
      const namespacesErr = checkStrArray(c.namespaces, 128, 32, `capabilities.${id}.namespaces`);
      if (namespacesErr) return { ok: false, error: namespacesErr };
      const allowErr = checkStrArray(c.allow, 256, 16, `capabilities.${id}.allow`);
      if (allowErr) return { ok: false, error: allowErr };
      const cap: PluginCapability = { id };
      if (Array.isArray(c.actions) && c.actions.length) cap.actions = c.actions as string[];
      if (Array.isArray(c.namespaces) && c.namespaces.length) cap.namespaces = c.namespaces as string[];
      if (Array.isArray(c.allow) && c.allow.length) cap.allow = c.allow as string[];
      capabilities.push(cap);
    }
  }

  return {
    ok: true,
    manifest: {
      name,
      displayName,
      version,
      engines: { sellerkit: String(engines.sellerkit).slice(0, 32) },
      activationEvents,
      ...(isPlainObj(raw.contributes)
        ? { contributes: raw.contributes as unknown as NonNullable<PluginManifest['contributes']> }
        : {}),
      ...(isStr(raw.description) ? { description: raw.description.slice(0, 200) } : {}),
      ...(isStr(raw.author) ? { author: raw.author.slice(0, 64) } : {}),
      entry,
      ...(capabilities.length ? { capabilities } : {}),
    },
  };
}
