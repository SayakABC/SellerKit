// src/core/plugin/uiBridgeHost.ts
// UI 岛桥（宿主端主线程）—— PLUGIN_ARCHITECTURE.md §15 P1：外置富 UI 插件（iframe 运行时岛）与宿主之间的 postMessage 会话。
// 职责：
//  1. 与 iframe 端运行时（electron/plugin-ui-runtime.js，由主进程协议注入 UI 包 HTML）完成 token 握手；
//  2. 转发 iframe 的能力调用到「已过权限门的 gated HostApi」（createGatedHostApi 产物）——越权在宿主侧拒绝并写入审计环；
//  3. 双向事件总线：iframe 订阅（subscribe/unsubscribe）映射到宿主总线 on/off；iframe publish 以 sourcePlugin 身份 emit；
//  4. 日志转发宿主 console；宿主 --wb-* 主题令牌注入 iframe。
// 安全边界：
//  - 只信 `sk-plugin://<pluginId>` 且 e.source 为本 iframe contentWindow 的消息；
//  - 能力面白名单 CALLS（domain.method）逐项校验参数类型后才调用（iframe 消息不可信，红线 3）；
//  - 权限判定不在此文件——一律交给 gated hostApi（gate.check + audit 在 security.ts/gatedHost.ts 完成）。
// 纪律（AGENTS 红线 20）：消息类型/载荷与 electron/plugin-ui-runtime.js 双端同步，改动须双端 + dev 冒烟。

import type { HostApi } from './sdk';
import type { PluginManifest } from './types';
import type { EventBus } from './eventBus';

/** 双端协议常量（镜像 electron/plugin-ui-runtime.js 顶部 TYPE——改动必须双端同步） */
export const UI_MSG = {
  mark: '__sk',
  hello: 'hello',
  boot: 'boot',
  call: 'call',
  callResult: 'call-result',
  subscribe: 'subscribe',
  unsubscribe: 'unsubscribe',
  publish: 'publish',
  log: 'log',
  event: 'event',
  theme: 'theme',
  abort: 'abort',
} as const;

/** 采集当前生效的宿主设计令牌（--wb-* 前缀），用于注入 iframe（宿主 data-theme 切换后重采） */
export function collectWbThemeVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const cs = getComputedStyle(document.documentElement);
    for (let i = 0; i < cs.length; i += 1) {
      const name = cs[i];
      if (name.startsWith('--wb-')) {
        const value = cs.getPropertyValue(name).trim();
        if (value) vars[name] = value;
      }
    }
  } catch {
    /* 主题采集失败不影响桥功能 */
  }
  return vars;
}

export interface UiIslandBridgeOptions {
  /** 插件 id（kebab-case，与 iframe src 的 host 一致） */
  pluginId: string;
  manifest: PluginManifest;
  /** 已过权限门的宿主能力面（createGatedHostApi 产物；越权由宿主侧拒绝 + 审计） */
  hostApi: HostApi;
  /** 宿主插件事件总线（publish 落点 / iframe 订阅源） */
  bus: EventBus;
  /** 环境快照（可选；缺省由 navigator 推断 isMac） */
  env?: { isMac: boolean; platform: string };
  /** 完成一次 boot 后回调（宿主 UI 可据此点亮"已连接"；iframe reload 后再次 boot 亦触发） */
  onBooted?: () => void;
}

export interface UiIslandBridge {
  /** 停用会话：移除监听、退订总线、通知 iframe 中止在途调用 */
  dispose(): void;
  /** 重推当前 --wb-* 令牌（宿主主题切换后调用） */
  pushTheme(): void;
}

interface CallSpec {
  arity: number;
  run: (host: HostApi, args: unknown[]) => Promise<unknown>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** 桥能力面白名单（对齐 host.ts/sdk.ts 的 HostApi；iframe 消息不可信，逐调用校验参数后再执行） */
const CALLS: Record<string, Record<string, CallSpec>> = {
  storage: {
    load: {
      arity: 1,
      run: (h, a) => (isStr(a[0]) ? h.storage.load(a[0]) : Promise.reject(new Error('storage.load: ns 必须为字符串'))),
    },
    save: {
      arity: 2,
      run: (h, a) =>
        isStr(a[0]) ? h.storage.save(a[0], a[1]) : Promise.reject(new Error('storage.save: ns 必须为字符串')),
    },
    clear: {
      arity: 1,
      run: (h, a) => (isStr(a[0]) ? h.storage.clear(a[0]) : Promise.reject(new Error('storage.clear: ns 必须为字符串'))),
    },
  },
  clipboard: {
    writeText: {
      arity: 1,
      run: (h, a) =>
        isStr(a[0]) ? h.clipboard.writeText(a[0]) : Promise.reject(new Error('clipboard.writeText: text 必须为字符串')),
    },
  },
  http: {
    get: {
      arity: 2,
      run: (h, a) =>
        isStr(a[0])
          ? h.http.get(a[0], isPlainObject(a[1]) ? a[1] : undefined)
          : Promise.reject(new Error('http.get: url 必须为字符串')),
    },
    post: {
      arity: 3,
      run: (h, a) =>
        isStr(a[0])
          ? h.http.post(a[0], a[1], isPlainObject(a[2]) ? a[2] : undefined)
          : Promise.reject(new Error('http.post: url 必须为字符串')),
    },
  },
  dialog: {
    openFile: {
      arity: 1,
      run: (h, a) => {
        if (a.length === 0) return h.dialog.openFile({ kind: 'excel' });
        if (isPlainObject(a[0]) && typeof a[0].kind === 'string') {
          return h.dialog.openFile({ kind: a[0].kind as 'excel' | 'template' | 'directory' });
        }
        return Promise.reject(new Error('dialog.openFile: opts.kind 必须为字符串'));
      },
    },
  },
  ui: {
    openSettings: {
      arity: 2,
      run: (h, a) => {
        h.ui.openSettings(isStr(a[0]) ? a[0] : undefined, isStr(a[1]) ? a[1] : undefined);
        return Promise.resolve(null);
      },
    },
    notify: {
      arity: 1,
      run: (h, a) => {
        const o = isPlainObject(a[0]) ? a[0] : null;
        if (!o || typeof o.text !== 'string') return Promise.reject(new Error('ui.notify: { text } 必须提供'));
        h.ui.notify({
          kind: o.kind === 'error' || o.kind === 'info' || o.kind === 'success' ? o.kind : 'info',
          text: o.text,
        });
        return Promise.resolve(null);
      },
    },
  },
};

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/**
 * 挂接 UI 岛桥（宿主端）。
 * 调用时机：iframe 已挂载后（iframe 内 runtime 会带退避重试握手，时序宽松）。
 */
export function attachUiIslandBridge(iframe: HTMLIFrameElement, opts: UiIslandBridgeOptions): UiIslandBridge {
  const { pluginId, manifest, hostApi, bus } = opts;
  let expectedOrigin = '';
  try {
    expectedOrigin = new URL(iframe.src).origin; // sk-plugin://<id>
  } catch {
    expectedOrigin = '';
  }
  let alive = true;
  let token: string | null = null;
  const unsubBySubId = new Map<number, () => void>();

  function post(data: Record<string, unknown>): void {
    if (!alive) return;
    try {
      iframe.contentWindow?.postMessage(data, expectedOrigin);
    } catch {
      /* iframe detached */
    }
  }

  function issueBoot(): void {
    token = crypto.randomUUID();
    const env = opts.env ?? {
      isMac: typeof navigator !== 'undefined' ? /mac/i.test(navigator.platform) : false,
      platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
    };
    post({
      __sk: 1,
      type: UI_MSG.boot,
      token,
      plugin: {
        id: pluginId,
        displayName: manifest.displayName ?? pluginId,
        version: manifest.version ?? '',
      },
      env,
      theme: { vars: collectWbThemeVars() },
    });
    opts.onBooted?.();
  }

  async function handleCall(d: Record<string, unknown>): Promise<void> {
    const id = d.id as number | string | undefined;
    const domain = d.domain as string | undefined;
    const method = d.method as string | undefined;
    const args = Array.isArray(d.args) ? (d.args as unknown[]) : [];
    const spec = (domain && method && CALLS[domain]?.[method]) || null;
    if (spec === null || typeof id === 'undefined') {
      post({
        __sk: 1,
        type: UI_MSG.callResult,
        id,
        ok: false,
        error: `桥拒绝未知调用: ${String(domain)}.${String(method)}`,
      });
      return;
    }
    if (args.length !== spec.arity) {
      post({
        __sk: 1,
        type: UI_MSG.callResult,
        id,
        ok: false,
        error: `桥参数数量不符: ${String(domain)}.${String(method)} 期望 ${spec.arity} 实收 ${args.length}`,
      });
      return;
    }
    try {
      const value = await Promise.resolve(spec.run(hostApi, args));
      post({ __sk: 1, type: UI_MSG.callResult, id, ok: true, value });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      post({ __sk: 1, type: UI_MSG.callResult, id, ok: false, error: message });
    }
  }

  function onMessage(e: MessageEvent): void {
    if (!alive) return;
    if (e.source !== iframe.contentWindow) return;
    if (expectedOrigin && e.origin !== expectedOrigin) return;
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (d.__sk !== 1 || typeof d.type !== 'string') return;
    if (d.type === UI_MSG.hello) {
      issueBoot(); // iframe reload 后重发 boot（token 旋转）
      return;
    }
    if (typeof d.token !== 'string' || d.token !== token) return; // token 门：伪造/串台丢弃
    switch (d.type) {
      case UI_MSG.call:
        void handleCall(d);
        break;
      case UI_MSG.subscribe: {
        const pattern = d.pattern;
        if (typeof pattern !== 'string' || !pattern || pattern.length > 128) break;
        const subId = typeof d.subId === 'number' ? d.subId : -1;
        if (subId < 0 || unsubBySubId.has(subId)) break;
        const off = bus.on(pattern, (payload, meta) => {
          post({
            __sk: 1,
            type: UI_MSG.event,
            eventType: (meta && (meta as { eventType?: string }).eventType) || pattern,
            payload,
            meta: {
              sourcePlugin: (meta as { sourcePlugin?: string } | undefined)?.sourcePlugin,
              origin: (meta as { origin?: string } | undefined)?.origin,
            },
          });
        });
        unsubBySubId.set(subId, off);
        break;
      }
      case UI_MSG.unsubscribe: {
        const off = unsubBySubId.get(d.subId as number);
        if (off) {
          off();
          unsubBySubId.delete(d.subId as number);
        }
        break;
      }
      case UI_MSG.publish: {
        const eventType = d.eventType;
        if (typeof eventType !== 'string' || !eventType || eventType.length > 128) break;
        bus.emit(eventType, d.payload, { sourcePlugin: pluginId, origin: 'plugin', serialized: true });
        break;
      }
      case UI_MSG.log: {
        const level = d.level as string;
        const args = Array.isArray(d.args) ? d.args : [];
        if (!LOG_LEVELS.includes(level as (typeof LOG_LEVELS)[number])) break;
        const prefix = `[ui-island:${pluginId}]`;
        const fn = console[level as 'debug' | 'info' | 'warn' | 'error'] ?? console.log;
        if (typeof fn === 'function') fn(prefix, ...args);
        break;
      }
      default:
        break;
    }
  }

  window.addEventListener('message', onMessage);

  return {
    dispose(): void {
      if (!alive) return;
      alive = false;
      window.removeEventListener('message', onMessage);
      unsubBySubId.forEach((off) => off());
      unsubBySubId.clear();
      post({ __sk: 1, type: UI_MSG.abort, reason: 'host bridge disposed' });
      token = null;
    },
    pushTheme(): void {
      if (!alive) return;
      post({ __sk: 1, type: UI_MSG.theme, vars: collectWbThemeVars() });
    },
  };
}
