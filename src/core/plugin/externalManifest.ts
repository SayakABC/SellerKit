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
  UiIslandSettingsContrib,
} from './types';

export type ManifestValidationResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string };

const CAPABILITIES: readonly CapabilityId[] = [
  'storage',
  'http',
  'clipboard',
  'dialog',
  'db',
  'secrets',
  'mail',
];
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * 单条 capability.actions 的条数上限。
 *
 * 由来（2026-09-21 真实故障）：原值 32 是按「粗略防护」拍的，未与实际业务域规模对齐。
 * 宿主 DB_OPS 里 `order-insight` 域自身就有 37 个 op、`purchase` 域 24 个，
 * 而 order-insight 插件跨两个域声明 58 个动作 → 安装期直接被判定为非法 manifest、
 * 整个插件加载失败（报「capabilities.db.actions 条数超限（≤32）」），且该报错不指向业务真实原因。
 *
 * 上层语义：actions 是「插件自报的动作白名单」，真正的越权判定在宿主权限门
 * （security.ts decidePermission）+ DB_OPS 登记表，本上限只用于抵御病态/超大 manifest。
 * 故取 128（约 2× 当前最大业务域规模的余量），新增业务域时无需再动这个常量。
 * 若未来单域 op 数逼近该值，应改为从宿主登记表推导上限，而不是继续手调。
 */
const MAX_ACTIONS = 128;

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

  // 懒激活事件：**当前只支持 `onStartup`**，其余一律丢弃。
  //
  // 旧注释写成"白名单识别（onStartup / onCommand:xxx ...）"，与实现不符：
  // 按注释写了 `onCommand:xxx` 的插件作者会得到"装上了、永远不激活"，且没有任何提示。
  // 现改为把被丢弃的声明**明确告警** —— 丢弃本身仍是既有行为（不新增激活语义），
  // 但不再静默（AGENTS §2.3）。
  const declaredEvents = Array.isArray(raw.activationEvents)
    ? raw.activationEvents.filter(isStr).slice(0, 16)
    : [];
  const activationEvents: ActivationEvent[] = [];
  const droppedEvents: string[] = [];
  for (const e of declaredEvents) {
    if (e === 'onStartup') activationEvents.push(e as ActivationEvent);
    else droppedEvents.push(e);
  }
  if (droppedEvents.length) {
    console.warn(
      `[plugin] manifest.activationEvents 目前仅支持 'onStartup'，已忽略: ${droppedEvents.join(
        ', ',
      )} —— 该插件不会被这些事件激活`,
    );
  }

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
      const actionsErr = checkStrArray(c.actions, 64, MAX_ACTIONS, `capabilities.${id}.actions`);
      if (actionsErr) return { ok: false, error: actionsErr };
      const namespacesErr = checkStrArray(c.namespaces, 128, 32, `capabilities.${id}.namespaces`);
      if (namespacesErr) return { ok: false, error: namespacesErr };
      const allowErr = checkStrArray(c.allow, 256, 16, `capabilities.${id}.allow`);
      if (allowErr) return { ok: false, error: allowErr };
      const domainsErr = checkStrArray(c.domains, 64, 16, `capabilities.${id}.domains`);
      if (domainsErr) return { ok: false, error: domainsErr };
      // `secrets` 无域粒度：gatedHost 传的是 { capability:'secrets', action:'status' }，不带 domain，
      // 而 security.ts 只在请求带 domain 时才做域校验 —— 所以这里声明 domains 会被**静默忽略**。
      // 不报错（避免打断既有 manifest），但必须让作者知道：否则会以为自己"限定了范围"，
      // 而实际放行与否与 domains 无关。
      if (id === 'secrets' && Array.isArray(c.domains) && c.domains.length) {
        console.warn(
          `[plugin] capabilities.secrets 不支持 domains（该能力无域粒度），已忽略: ${(c.domains as string[]).join(
            ', ',
          )}`,
        );
      }
      const cap: PluginCapability = { id };
      if (Array.isArray(c.actions) && c.actions.length) cap.actions = c.actions as string[];
      if (Array.isArray(c.namespaces) && c.namespaces.length) cap.namespaces = c.namespaces as string[];
      if (Array.isArray(c.allow) && c.allow.length) cap.allow = c.allow as string[];
      if (Array.isArray(c.domains) && c.domains.length) cap.domains = c.domains as string[];
      capabilities.push(cap);
    }
  }

  // UI 岛设置面板贡献（manifest.settings，§15）：仅 kind==='ui' 时生效；entry 与主入口同规则校验
  let settingsContrib: UiIslandSettingsContrib | undefined;
  if (raw.kind === 'ui' && isPlainObj(raw.settings)) {
    const s = raw.settings as Record<string, unknown>;
    const sEntry = isStr(s.entry) ? s.entry.trim() : '';
    if (sEntry) {
      if (!sEntry.startsWith('./') || sEntry.includes('..')) {
        return { ok: false, error: `manifest.settings.entry 非法（须为 ./ 开头的相对路径）: ${sEntry}` };
      }
      settingsContrib = {
        entry: sEntry,
        ...(isStr(s.displayName) ? { displayName: s.displayName.slice(0, 32) } : {}),
        ...(isStr(s.icon) ? { icon: s.icon.slice(0, 24) } : {}),
        ...(Number.isFinite(Number(s.order)) ? { order: Number(s.order) } : {}),
      };
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
      // 形态标识（§15）：仅放行 'ui'（预构建静态站点/iframe 岛）；未知 kind 忽略保持兼容
      ...(raw.kind === 'ui' ? { kind: 'ui' } : {}),
      ...(capabilities.length ? { capabilities } : {}),
      ...(settingsContrib ? { settings: settingsContrib } : {}),
    },
  };
}
