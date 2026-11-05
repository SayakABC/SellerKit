// src/core/plugin/uiBridgeHost.ts
// UI 岛桥（宿主端主线程）—— docs/architecture/PLUGIN_ARCHITECTURE.md §15 P1：外置富 UI 插件（iframe 运行时岛）与宿主之间的 postMessage 会话。
// 职责：
//  1. 与 iframe 端运行时（electron/plugin-ui-runtime.js，由主进程协议注入 UI 包 HTML）完成 token 握手；
//  2. 转发 iframe 的能力调用到「已过权限门的 gated HostApi」（createGatedHostApi 产物）——越权在宿主侧拒绝并写入审计环；
//  3. 双向事件总线：iframe 订阅（subscribe/unsubscribe）映射到宿主总线 on/off；iframe publish 以 sourcePlugin 身份 emit；
//  4. 日志转发宿主 console；宿主 --wb-* 主题令牌注入 iframe（+ theme.mode 供岛内回写 color-scheme）。
// 安全边界：
//  - 只信 `sk-plugin://<pluginId>` 且 e.source 为本 iframe contentWindow 的消息；
//  - 能力面白名单 CALLS（domain.method）逐项校验参数类型后才调用（iframe 消息不可信，红线 3）；
//  - 权限判定不在此文件——一律交给 gated hostApi（gate.check + audit 在 security.ts/gatedHost.ts 完成）。
// 纪律（AGENTS 红线 20）：消息类型/载荷与 electron/plugin-ui-runtime.js 双端同步，改动须双端 + dev 冒烟。

import type { HostApi } from './sdk';
import type { PluginManifest } from './types';
import type { EventBus } from './eventBus';
import { exceedsByteBudget, MAX_PAYLOAD_BYTES } from './payloadBudget';

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

/**
 * 宿主设计令牌清单（与 src/styles/index.css 的 :root / [data-theme='dark'] 对应）。
 * 用途：部分引擎的 getComputedStyle 索引枚举不返回自定义属性，仅靠 cs[i] 会拿不到令牌；
 * 显式清单用 getPropertyValue 逐个读取，保证 UI 岛一定能拿到主题色。新增令牌需同步此处与 index.css。
 */
export const WB_THEME_TOKENS = [
  '--wb-bg',
  '--wb-surface',
  '--wb-surface-2',
  '--wb-border',
  '--wb-border-strong',
  '--wb-text',
  '--wb-text-muted',
  '--wb-primary',
  '--wb-primary-hover',
  '--wb-primary-soft',
  '--wb-primary-contrast',
  '--wb-on-accent',
  '--wb-success',
  '--wb-success-soft',
  '--wb-warning',
  '--wb-warning-soft',
  '--wb-danger',
  '--wb-danger-soft',
  '--wb-accent',
  '--wb-accent-soft',
  '--wb-hover',
  '--wb-overlay',
  '--wb-shadow',
  '--wb-elev-1',
  '--wb-elev-2',
  '--wb-elev-3',
  '--wb-radius',
  '--wb-radius-sm',
  '--wb-radius-md',
  '--wb-radius-lg',
  '--wb-focus',
  '--wb-focus-ring',
  // 字阶（2026-11-03 界面方案 §4.1）：岛内要跟宿主"同一套级差"就得拿到这几档。
  // ⚠️ 漏在这里不会报错 —— 岛内 var() 解析失败 ⇒ 整条 font-size 声明被丢弃 ⇒ 岛内退回默认 16px，
  //    表现为"插件字体比宿主大一截"。本清单由 tests/uiIslandThemeTokens.spec.ts 双向校验。
  '--wb-fs-hero',
  '--wb-fs-display',
  '--wb-fs-title',
  '--wb-fs-subtitle',
  '--wb-fs-body',
  '--wb-fs-caption',
  '--wb-fs-micro',
] as const;

/** 采集当前生效的宿主设计令牌（--wb-* 前缀），用于注入 iframe（宿主 data-theme 切换后重采） */
export function collectWbThemeVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const cs = getComputedStyle(document.documentElement);
    // 1) 显式清单：确定性读取（引擎无关）
    for (const name of WB_THEME_TOKENS) {
      const value = cs.getPropertyValue(name).trim();
      if (value) vars[name] = value;
    }
    // 2) 索引枚举：补齐清单外的自定义属性（引擎支持时生效）
    for (let i = 0; i < cs.length; i += 1) {
      const name = cs[i];
      if (name.startsWith('--wb-') && !vars[name]) {
        const value = cs.getPropertyValue(name).trim();
        if (value) vars[name] = value;
      }
    }
  } catch {
    /* 主题采集失败不影响桥功能 */
  }
  return vars;
}

/**
 * 当前生效的主题模式（供岛内回写 `color-scheme`）。
 *
 * 背景（2026-09-22 修）：`color-scheme` **不是**设计令牌，无法随 --wb-* 一起注入；
 * 岛若把它写死 `light`（或在 CSS 里不声明），深色主题下岛内原生控件
 * （日期选择器 / 下拉弹层 / 滚动条 / 复选框 / 输入光标）仍是浅色，表现为
 * 「岛内样式跟宿主主题不一致」——文字与面板已经变黑，只有原生件是白的。
 * 故 boot/theme 载荷额外带上模式，由运行时写到 iframe 的 <html> 内联样式上
 * （内联优先级 > 岛内样式表，可覆盖岛里写死的 color-scheme）。
 */
export function currentThemeMode(): 'light' | 'dark' | undefined {
  try {
    const v = document.documentElement.getAttribute('data-theme');
    return v === 'dark' || v === 'light' ? v : undefined;
  } catch {
    return undefined;
  }
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
  /**
   * 握手**确认**回调（宿主 UI 据此点亮"已连接"）。
   * 语义（2026-09-22 收紧）：不是"宿主发出了 boot"，而是**收到了岛的带 token 回执**——
   * 岛只有真正拿到 boot 才可能带上 token 回话，这样状态灯不再出现"宿主说已连接、岛说没握手"的自相矛盾。
   * 每次会话只触发一次（iframe reload 会以新会话重新触发）。
   */
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
// 业务域 / 操作名的长度与字符约束（宿主登记表有限，超长一律拒绝，避免畸形参数进 IPC）
const isShortName = (v: unknown): v is string => isStr(v) && v.length > 0 && v.length <= 64;

const CALLS: Record<string, Record<string, CallSpec>> = {
  db: {
    call: {
      // 只放行登记表内业务操作（不放行任意 SQL），domain/op 必为字符串
      arity: 3,
      run: (h, a) =>
        isShortName(a[0]) && isShortName(a[1])
          ? h.db.call(a[0], a[1], a[2])
          : Promise.reject(new Error('db.call: domain/op 必须为非空字符串（≤64）')),
    },
  },
  secrets: {
    status: { arity: 0, run: (h) => h.secrets.status() },
  },
  mail: {
    call: {
      arity: 2,
      run: (h, a) =>
        isShortName(a[0])
          ? h.mail.call(a[0], a[1])
          : Promise.reject(new Error('mail.call: op 必须为非空字符串（≤64）')),
    },
  },
  storage: {
    load: {
      arity: 1,
      run: (h, a) =>
        isStr(a[0])
          ? h.storage.load(a[0])
          : Promise.reject(new Error('storage.load: ns 必须为字符串')),
    },
    save: {
      arity: 2,
      run: (h, a) =>
        isStr(a[0])
          ? h.storage.save(a[0], a[1])
          : Promise.reject(new Error('storage.save: ns 必须为字符串')),
    },
    clear: {
      arity: 1,
      run: (h, a) =>
        isStr(a[0])
          ? h.storage.clear(a[0])
          : Promise.reject(new Error('storage.clear: ns 必须为字符串')),
    },
  },
  clipboard: {
    writeText: {
      arity: 1,
      run: (h, a) =>
        isStr(a[0])
          ? h.clipboard.writeText(a[0])
          : Promise.reject(new Error('clipboard.writeText: text 必须为字符串')),
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
          return h.dialog.openFile({
            kind: a[0].kind as 'excel' | 'image' | 'template' | 'directory',
          });
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
        if (!o || typeof o.text !== 'string')
          return Promise.reject(new Error('ui.notify: { text } 必须提供'));
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
 * 期望来源（既作宿主 → 岛的 targetOrigin，也作岛 → 宿主的 origin 校验值）。
 *
 * 优先按 `iframe.src` 解析；**src 尚未就绪时按插件 id 推导**——`sk-plugin` 是 standard scheme
 * （`electron/plugin-ui-protocol.ts` registerSchemesAsPrivileged），其 origin 形如 `sk-plugin://<id>`，
 * 与 URL 解析结果完全一致（Chromium 实测），因此这条路不是猜测，而是同一个值的另一来源。
 *
 * 背景（2026-09-22 第二处故障，比第一处更隐蔽）：`attachUiIslandBridge` 可能在 iframe **尚未导航**时被调用
 * （组件挂载那一帧 `src` 还是空串，或还是 about:blank）。旧实现只在此处 `new URL(iframe.src).origin`
 * 且把异常吞掉 → `expectedOrigin` 落成 **空串**，于是：
 *   ① `postMessage(data, '')` 是**非法 targetOrigin**（抛 SyntaxError），异常又被 `post()` 的 try/catch 吞掉 →
 *      **宿主所有下行消息（boot / theme / call-result / abort）全部静默发不出去**；
 *   ② 而 hello 的 origin 校验因 `expectedOrigin` 为空被**跳过**（`if (expectedOrigin && ...)`），宿主照样
 *      `issueBoot()` 并触发 `onBooted` → 状态灯变绿、宿主自认已连接，岛侧却永远收不到 boot →
 *      首屏停在「等待宿主桥握手超时（8s）」，点「重新加载」重建会话才恢复。
 * 修法即本函数：**任何情况下都返回一个真实可用的 origin**（解析 < 推导兜底），绝不落成空串。
 */
function resolveExpectedOrigin(iframe: HTMLIFrameElement, pluginId: string): string {
  try {
    const o = new URL(iframe.src).origin;
    if (o && o !== 'null') return o; // 'null' = 不透明 origin（about:blank / 未注册 scheme）→ 走推导
  } catch {
    /* src 尚未赋值：不是错误，走推导 */
  }
  return `sk-plugin://${pluginId}`;
}

/**
 * 挂接 UI 岛桥（宿主端）。
 * 调用时机：iframe 已挂载后（iframe 内 runtime 会带退避重试握手，时序宽松）。
 */
export function attachUiIslandBridge(
  iframe: HTMLIFrameElement,
  opts: UiIslandBridgeOptions
): UiIslandBridge {
  const { pluginId, manifest, hostApi, bus } = opts;
  // 绝不为空串（详见 resolveExpectedOrigin 注释：空串作 targetOrigin 非法 → 抛异常 → 下行消息静默全丢）
  const expectedOrigin = resolveExpectedOrigin(iframe, pluginId);
  let alive = true;
  let token: string | null = null;
  /** 是否已收到岛的**真实回执**（带 token 的合法消息）——状态灯据此点亮，不再"我发了 boot 就算连上" */
  let booted = false;
  let warnedPostFailure = false;
  /** 是否已就"来源不符"告警过（每次会话只留一条，避免刷屏） */
  let warnedOriginMismatch = false;
  const unsubBySubId = new Map<number, () => void>();

  function post(data: Record<string, unknown>): void {
    if (!alive) return;
    try {
      iframe.contentWindow?.postMessage(data, expectedOrigin);
    } catch (err) {
      // 旧实现此处静默吞掉，导致「boot 根本没发出去」在现场毫无痕迹。留一条痕迹，但只留一次。
      if (!warnedPostFailure) {
        warnedPostFailure = true;
        console.warn(
          `[ui-island:${pluginId}] 宿主 → 岛消息投递失败（targetOrigin=${expectedOrigin}）`,
          err
        );
      }
    }
  }

  function bootPayload(): Record<string, unknown> {
    const env = opts.env ?? {
      isMac: typeof navigator !== 'undefined' ? /mac/i.test(navigator.platform) : false,
      platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
    };
    return {
      __sk: 1,
      type: UI_MSG.boot,
      token,
      plugin: {
        id: pluginId,
        displayName: manifest.displayName ?? pluginId,
        version: manifest.version ?? '',
      },
      env,
      theme: { vars: collectWbThemeVars(), mode: currentThemeMode() },
    };
  }

  /**
   * 重发当前 boot（**不轮转 token**）。
   *
   * 背景（2026-09-22 修）：原先收到 hello 一律 `issueBoot()`（重新生成 token），
   * 与「iframe load 安全网」撞车时会产生静默死锁：
   *   1. iframe 的 load 早于 hello 到达宿主 → 安全网发 boot(A)，岛收到后 ready，立即发出首批 call(带 A)；
   *   2. 紧接着迟到的 hello 到达 → 老实现轮转成 boot(B)，宿主侧 token 变为 B；
   *   3. 首批 call(带 A) 被宿主判为串台**直接丢弃且不回包** → iframe 侧 pending 永远挂着，
   *      表现为「岛首屏永久加载中，必须手动点『重新加载』才恢复」（重启后冷启动必现）。
   * token 只是"本会话的共享密钥"，复用它不降低安全性（来源判定仍靠 e.source + origin）；
   * 轮转的唯一收益（iframe reload 后旧文档失效）在此由 e.source/文档销毁本身保证。
   */
  function repostBoot(): void {
    post(bootPayload());
  }

  function issueBoot(): void {
    token = crypto.randomUUID();
    post(bootPayload());
  }

  /**
   * 握手成功判定：**以岛的真实回执为准**，而不是"宿主发了 boot"。
   *
   * 背景（2026-09-22）：旧实现在 `issueBoot()`/`repostBoot()` 里直接触发 `onBooted`，
   * 于 `expectedOrigin` 为空串的故障中出现了最误导的现场——宿主状态灯显示「桥已连接」，
   * 而岛内文案是「宿主桥已注入，但未收到 boot 握手」。两者同时出现会让人去查错方向。
   * 现在改为：收到**带正确 token 的岛消息**（call / subscribe / publish / log）才算连上——
   * 岛只有真正拿到 boot 才可能带上 token 回话。
   */
  function markBootConfirmed(): void {
    if (booted) return;
    booted = true;
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
    // 载荷体积预算（M-02）：arity 只保证"参数个数对"，不保证"参数不大"。
    // 超限直接回错，不让它进入下游的消毒复制与规则引擎遍历。
    // 注：结构化克隆在此之前的 postMessage 阶段已完成，此处拦的是后续放大。
    if (exceedsByteBudget(args)) {
      post({
        __sk: 1,
        type: UI_MSG.callResult,
        id,
        ok: false,
        error: `桥拒绝超大载荷: ${String(domain)}.${String(method)} 超过 ${Math.round(
          MAX_PAYLOAD_BYTES / 1024 / 1024
        )}MB 预算`,
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
    if (expectedOrigin && e.origin !== expectedOrigin) {
      // 来源不符：**只可能是"这个 iframe 已经导航到了别的岛"**（同一 iframe 元素、换岛未重建桥）。
      // 旧实现完全静默，于是现场表现为「新岛一片空白、宿主工具条却显示桥已连接」，排查全靠猜。
      // 留一条一次性的痕迹（正常流程下永不触发：换岛会先 dispose 再重建桥）。
      if (!warnedOriginMismatch) {
        warnedOriginMismatch = true;
        console.warn(
          `[ui-island:${pluginId}] 收到来源不符的岛消息（got=${e.origin} want=${expectedOrigin}）：` +
            `本桥会话属于另一个岛，消息已丢弃。请确认切岛时重建了桥（AppShell 的 UiIslandView :key）。`
        );
      }
      return;
    }
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (d.__sk !== 1 || typeof d.type !== 'string') return;
    if (d.type === UI_MSG.hello) {
      // 不轮转 token：已发过 boot 就重发同一份（幂等补发），避免"迟到的 hello"作废在途调用
      if (token === null) issueBoot();
      else repostBoot();
      return;
    }
    if (typeof d.token !== 'string' || d.token !== token) {
      // 会话已失效（iframe reload / 桥重建）时**必须回包**：
      // 原实现静默丢弃，iframe 侧 pending 永不 reject，调用方 await 永久挂起（无法自愈、无日志）。
      if (d.type === UI_MSG.call && typeof d.id !== 'undefined') {
        post({
          __sk: 1,
          type: UI_MSG.callResult,
          id: d.id,
          ok: false,
          error: '桥会话已失效（token 不匹配）：请重新加载视图',
        });
      }
      return;
    }
    switch (d.type) {
      case UI_MSG.call:
        markBootConfirmed(); // 岛带了正确 token 回话 → 它确实收到了 boot（在 handleCall 前判定，避免异步竞态）
        void handleCall(d);
        break;
      case UI_MSG.subscribe: {
        markBootConfirmed();
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
        markBootConfirmed();
        const eventType = d.eventType;
        if (typeof eventType !== 'string' || !eventType || eventType.length > 128) break;
        bus.emit(eventType, d.payload, {
          sourcePlugin: pluginId,
          origin: 'plugin',
          serialized: true,
        });
        break;
      }
      case UI_MSG.log: {
        markBootConfirmed();
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

  /**
   * iframe 文档加载完成 → 补发 boot。**每次 load 都发**（旧版仅在 token === null 时发）。
   *
   * 为什么改成每次：`load` 事件意味着**一个新的文档**已就绪，而它必然还没握过手。
   * 旧版"已握手就不发"的顾虑是 token 轮转会把在途 call 判成串台，但轮转已在 2026-09-22 去掉
   * （`repostBoot` 复用同一 token），补发因此变得廉价且幂等。
   *
   * 这一条同时兜住「attach 时 iframe 尚未导航（src 仍为空 / about:blank）」的时序：
   * 那次 attach 发出的 boot 落在旧文档（无人接收），随后真实文档 load 时再补一次即可。
   * 若 attach 本身晚于 load（如岛运行时迟到），则退化为 hello 驱动的握手（岛侧持续重试）。
   */
  function onFrameLoad(): void {
    if (!alive) return;
    if (token === null) issueBoot();
    else repostBoot();
  }
  iframe.addEventListener('load', onFrameLoad);

  return {
    dispose(): void {
      if (!alive) return;
      // 顺序敏感：post() 自带 `if (!alive) return` 守卫，若先置 alive=false 再发 abort，
      // 这条消息**永远发不出去**（测试 tests/uiBridgeHost.spec.ts 抓到过）——
      // 岛内在途 call 的 pending 就再也不会被 reject，与本文件顶部修的死锁同属「静默挂起」。
      post({ __sk: 1, type: UI_MSG.abort, reason: 'host bridge disposed' });
      alive = false;
      iframe.removeEventListener('load', onFrameLoad);
      window.removeEventListener('message', onMessage);
      unsubBySubId.forEach((off) => off());
      unsubBySubId.clear();
      token = null;
    },
    pushTheme(): void {
      if (!alive) return;
      post({ __sk: 1, type: UI_MSG.theme, vars: collectWbThemeVars(), mode: currentThemeMode() });
    },
  };
}
