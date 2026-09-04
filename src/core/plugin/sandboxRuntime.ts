// @ts-nocheck
// src/core/plugin/sandboxRuntime.ts —— Worker 沙箱运行时（Phase 4）。
//
// ⚠️ 本文件以"纯 JS + 内嵌字符串"形态注入 Blob module worker 执行（宿主 sandbox.ts 以 ?raw 引入）：
//   - 禁止 import/export/TS 类型语法（末尾 `export {}` 仅为让 TS 视其为模块，是合法 ESM 空导出）；
//   - 禁止访问 window / DOM / localStorage / electronAPI —— Worker 里只有 postMessage 与纯计算；
//   - 插件源码在沙箱内以 blob URL 动态 import 求值，与宿主不共享 realm。
//
// 桥协议（字符串字面量必须与 src/core/plugin/sandbox.ts 中的 MSG 常量一一对应，改动需两处同步）：
//   宿主 → Worker: boot | run-command | event | deactivate | abort
//   Worker → 宿主: activated | boot-error | deactivated | command-result | call | log
//                | register-command | unregister-command | register-contribution
//                | unregister-contribution | subscribe | unsubscribe | publish
//   关联规则：
//     - call（Worker→宿主能力调用）以 payload.id 关联，宿主回 call-result { id, ok, value|error }；
//     - boot / run-command / deactivate（宿主→Worker 请求）以 payload.rid 关联，Worker 以
//       activated / boot-error / command-result / deactivated 应答（含 rid 回显）；
//     - event / abort / log 等为单向消息，无需应答。
//   鉴权：首次 boot 消息建立 token；此后所有消息必须携带相同 token（防 Worker 内伪造/串台）。

// ---- 消息名常量表（与 sandbox.ts MSG 一致） ----
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
};

/** 会话状态（一次 boot → deactivate 为一个会话） */
let session = null;
let token = null;
let seq = 0; // call / rid 共用自增序号

/** Worker → 宿主应答等待表（call 用 id，宿主请求用 rid 回显，共用映射无冲突） */
const pending = new Map();

function send(type, payload) {
  const envelope = { token, type, payload };
  try {
    self.postMessage(envelope);
  } catch (e) {
    // 载荷不可结构化克隆（如函数/循环引用）：转成错误型应答，由调用方感知
    if (type === MSG.call) {
      const req = envelope.payload;
      const rec = pending.get(req && req.id);
      if (rec) {
        pending.delete(req.id);
        rec.reject(new Error('插件调用宿主时载荷不可序列化: ' + (e && e.message ? e.message : String(e))));
      }
    }
  }
}

/** 插件 → 宿主能力调用（跨桥，宿主侧过权限门） */
function callHost(domain, method, args) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      self.postMessage({ token, type: MSG.call, payload: { id, domain, method, args } });
    } catch (e) {
      pending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function createSession(payload) {
  const session = {
    pluginId: payload.pluginId,
    manifest: payload.manifest,
    env: payload.env && typeof payload.env === 'object' ? payload.env : {},
    lifecycle: null,
    ctx: null,
    abort: null,
    commands: new Map(), // localId -> run fn
    contribs: new Map(), // `${type}:${localId}` -> true（注册标记）
    busEntries: new Map(), // subId -> { type, handler, once }
    subSeq: 0,
  };
  return session;
}

/** 构造插件 ctx（host/storage/bus/contributions/log/abort 全部为跨桥代理） */
function buildContext() {
  const s = session;
  const abort = new AbortController();
  s.abort = abort;

  const host = {
    storage: {
      load: (ns) => callHost('storage', 'load', [ns]),
      save: (ns, v) => callHost('storage', 'save', [ns, v]),
      clear: (ns) => callHost('storage', 'clear', [ns]),
    },
    clipboard: {
      writeText: (text) => callHost('clipboard', 'writeText', [text]),
    },
    http: {
      get: (url, opts) => callHost('http', 'get', [url, opts]),
      post: (url, body, opts) => callHost('http', 'post', [url, body, opts]),
    },
    dialog: {
      openFile: (opts) => callHost('dialog', 'openFile', [opts]),
    },
    ui: {
      openSettings: (category, tab) => {
        void callHost('ui', 'openSettings', [category, tab]);
      },
      notify: (o) => {
        void callHost('ui', 'notify', [o]);
      },
    },
    env: s.env,
  };

  // 插件专属命名空间存储（key 级 API）：底层落 modules.<pluginId>，均走宿主桥（自身命名空间恒放行）
  const storage = {
    async load(key) {
      const rec = await callHost('storage', 'load', [s.pluginId]);
      if (rec === null || rec === undefined) return undefined;
      return rec[key];
    },
    async save(key, value) {
      const rec = (await callHost('storage', 'load', [s.pluginId])) || {};
      rec[key] = value;
      await callHost('storage', 'save', [s.pluginId, rec]);
    },
    async clear() {
      await callHost('storage', 'clear', [s.pluginId]);
    },
  };

  const removeBusEntry = (subId) => {
    if (s.busEntries.delete(subId)) send(MSG.unsubscribe, { subId });
  };

  const bus = {
    on(type, handler) {
      const subId = `s${++s.subSeq}`;
      s.busEntries.set(subId, { type, handler, once: false });
      send(MSG.subscribe, { subId, type });
      return () => removeBusEntry(subId);
    },
    once(type, handler) {
      const subId = `s${++s.subSeq}`;
      s.busEntries.set(subId, { type, handler, once: true });
      send(MSG.subscribe, { subId, type });
      return () => removeBusEntry(subId);
    },
    off(type, handler) {
      for (const [subId, rec] of s.busEntries) {
        if (rec.type === type && rec.handler === handler) {
          removeBusEntry(subId);
          break;
        }
      }
    },
    emit(type, payload, meta) {
      send(MSG.publish, { type, payload: payload === undefined ? null : payload, meta: meta || {} });
      return Promise.resolve();
    },
  };

  const contributions = {
    register(type, id, spec) {
      if (type === 'views') {
        throw new Error('沙箱插件不支持视图贡献（外置插件为后台贡献型，命令进 ⌘K）');
      }
      if (type === 'commands') {
        throw new Error('命令贡献请使用 registerCommand(spec)');
      }
      const key = `${type}:${id}`;
      if (s.contribs.has(key)) throw new Error(`重复贡献: ${type}.${id}`);
      s.contribs.set(key, true);
      send(MSG.registerContribution, { type, id, spec });
      return () => {
        if (s.contribs.delete(key)) send(MSG.unregisterContribution, { type, id });
      };
    },
    registerCommand(spec) {
      if (!spec || typeof spec.id !== 'string' || !spec.title || typeof spec.run !== 'function') {
        throw new Error('registerCommand 需要 { id, title, run }');
      }
      const key = `commands:${spec.id}`;
      if (s.commands.has(spec.id)) throw new Error(`重复命令: ${spec.id}`);
      s.commands.set(spec.id, spec.run);
      s.contribs.set(key, true);
      send(MSG.registerCommand, {
        id: spec.id,
        title: spec.title,
        ...(typeof spec.order === 'number' ? { order: spec.order } : {}),
        shortcut: spec.shortcut,
      });
      return () => {
        if (s.commands.delete(spec.id) && s.contribs.delete(key)) {
          send(MSG.unregisterCommand, { id: spec.id });
        }
      };
    },
    registerView() {
      throw new Error('沙箱插件不支持视图贡献（外置插件为后台贡献型，命令进 ⌘K）');
    },
    registerSetting(spec) {
      if (!spec || typeof spec.id !== 'string') throw new Error('registerSetting 需要 { id, ... }');
      const key = `settings:${spec.id}`;
      if (s.contribs.has(key)) throw new Error(`重复设置: ${spec.id}`);
      s.contribs.set(key, true);
      send(MSG.registerContribution, { type: 'settings', id: spec.id, spec });
      return () => {
        if (s.contribs.delete(key)) send(MSG.unregisterContribution, { type: 'settings', id: spec.id });
      };
    },
  };

  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    log[level] = (message, ...args) => send(MSG.log, { level, args: [message, ...args] });
  }

  return {
    manifest: s.manifest,
    trustLevel: 2, // §9 分级：Worker 沙箱 = Level 2（能力判定仍在宿主侧执行）
    bus,
    contributions,
    host,
    storage,
    log,
    abort: abort.signal,
  };
}

/** boot：宿主首次消息（带 token）。动态 import 插件源码 → 运行 activate → 应答 */
async function handleBoot(payload, bootToken) {
  const rid = payload.rid;
  try {
    // 幂等/防伪：boot 只允许一次；token（信封层）必须先于任何执行建立
    if (!bootToken) {
      throw new Error('boot 缺少 token');
    }
    if (token) {
      throw new Error('重复 boot');
    }
    token = bootToken;
    const code = payload.source;
    if (typeof code !== 'string' || !code.trim()) {
      throw new Error('插件源码为空');
    }
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    let mod;
    try {
      mod = await import(/* webpackIgnore: true */ url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const obj = (mod && (mod.default || mod)) || {};
    if (typeof obj.activate !== 'function') {
      throw new Error('插件入口须 default 导出 { activate(ctx), deactivate?(ctx) }');
    }
    session = createSession(payload);
    const ctx = buildContext();
    session.lifecycle = {
      activate: obj.activate,
      deactivate: typeof obj.deactivate === 'function' ? obj.deactivate : null,
    };
    session.ctx = ctx;
    await session.lifecycle.activate(ctx);
    send(MSG.activated, { rid });
  } catch (e) {
    const error = {
      name: e && e.name ? e.name : 'Error',
      message: e instanceof Error ? e.message : String(e),
    };
    send(MSG.bootError, { rid, error });
  }
}

/** run-command：宿主请求执行已注册命令（⌘K 触发） */
function handleRunCommand(payload) {
  const fn = session && session.commands.get(payload.id);
  Promise.resolve()
    .then(() => (typeof fn === 'function' ? fn() : undefined))
    .then(() => send(MSG.commandResult, { rid: payload.rid, ok: true }))
    .catch((e) => {
      const error = {
        name: e && e.name ? e.name : 'Error',
        message: e instanceof Error ? e.message : String(e),
      };
      send(MSG.commandResult, { rid: payload.rid, ok: false, error });
    });
}

/** deactivate：运行插件停用钩子 → 应答（异常以 error 字段回传，不中断宿主清理） */
async function handleDeactivate(payload) {
  const s = session;
  let error = null;
  if (s && s.lifecycle && typeof s.lifecycle.deactivate === 'function') {
    try {
      await s.lifecycle.deactivate(s.ctx);
    } catch (e) {
      error = {
        name: e && e.name ? e.name : 'Error',
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
  if (s && s.abort) {
    try {
      s.abort.abort();
    } catch (e) {
      /* ignore */
    }
  }
  send(MSG.deactivated, { rid: payload.rid, error });
}

/**
 * 通配 pattern 判定（T9）：type 以 * 结尾视为通配（如 'plugin:*' 命中全部 plugin: 前缀事件）。
 * 宿主端等价逻辑在 eventBus.ts（宿主侧为通用实现）；此处为纯 JS 内联副本——按红线 21，
 * 本文件禁止 import，改动须两处同步并跑冒烟。
 */
function isPatternType(type) {
  return typeof type === 'string' && type.length > 0 && type.endsWith('*');
}
function matchesPattern(pattern, type) {
  return isPatternType(pattern) && typeof type === 'string' && type.startsWith(pattern.slice(0, -1));
}

/** event：宿主推送总线事件给已订阅的插件（payload 经结构化克隆；type 为实际事件名） */
function handleEvent(payload) {
  const s = session;
  if (!s) return;
  const type = payload.type;
  const matches = [];
  for (const [subId, rec] of s.busEntries) {
    // 精确订阅与通配订阅（'plugin:*'）本地同时路由，互不覆盖
    if (rec.type === type || matchesPattern(rec.type, type)) matches.push([subId, rec]);
  }
  for (const [subId, rec] of matches) {
    if (rec.once) removeBusEntryLocal(s, subId);
    try {
      void rec.handler(payload.payload, payload.meta);
    } catch (e) {
      send(MSG.log, {
        level: 'error',
        args: [`bus handler error: ${e instanceof Error ? e.message : String(e)}`],
      });
    }
  }
}

function removeBusEntryLocal(s, subId) {
  if (s.busEntries.delete(subId)) send(MSG.unsubscribe, { subId });
}

// ---- 主消息入口 ----
self.addEventListener('message', (ev) => {
  const data = ev.data;
  if (!data || typeof data !== 'object') return;
  // boot 是首个消息：建立 token 后其余消息校验 token（防 Worker 内插件代码伪造宿主消息）
  if (data.type === MSG.boot) {
    void handleBoot(data.payload || {}, data.token);
    return;
  }
  if (!token || data.token !== token) return;
  const p = data.payload || {};
  switch (data.type) {
    case MSG.callResult: {
      const rec = pending.get(p.id);
      if (!rec) break;
      pending.delete(p.id);
      if (p.ok) {
        rec.resolve(p.value);
      } else {
        const err = new Error(p.error && p.error.message ? p.error.message : 'host call failed');
        err.name = p.error && p.error.name ? p.error.name : 'Error';
        rec.reject(err);
      }
      break;
    }
    case MSG.runCommand:
      handleRunCommand(p);
      break;
    case MSG.event:
      handleEvent(p);
      break;
    case MSG.deactivate:
      void handleDeactivate(p);
      break;
    case MSG.abort:
      if (session && session.abort) session.abort.abort();
      break;
    default:
      break;
  }
});

// 会话兜底：Worker 级未捕获异常（插件自身同步抛错且未被 activate 捕获时）上报宿主
self.addEventListener('error', (ev) => {
  // 仅上报不被上层 try/catch 覆盖的运行时错误；activate/deactivate/run 均已收敛
  send(MSG.log, {
    level: 'error',
    args: [`sandbox uncaught: ${ev && ev.message ? ev.message : String(ev)}`],
  });
});

export {};
