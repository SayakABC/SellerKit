// electron/plugin-ui-runtime.js
// UI 岛桥运行时（iframe 端）—— 由主进程 sk-plugin:// 协议以同源 <script> 注入任意 UI 包 HTML 文档。
// 本文件是「宿主注入的资源文本」：无 import/export（整文件 IIFE）、不触碰宿主 window（仅 postMessage 与自身 DOM）。
// 双端协议纪律（AGENTS 红线 20）：消息类型/载荷字段与宿主端 src/core/plugin/uiBridgeHost.ts 的 UI_MSG 常量一一对应，
//   任何改动必须双端同步并跑通 dev 冒烟（boot→call→subscribe→publish→abort）。
// 消息流：
//   iframe → host: hello(握手，无 token) / call{id,domain,method,args} / subscribe{subId,pattern} /
//                  unsubscribe{subId} / publish{eventType,payload} / log{level,args}
//   host → iframe: boot{token,plugin,env,theme} / call-result{id,ok,value|error} /
//                  event{eventType,payload,meta} / theme{vars} / abort{reason}
// token：boot 携带的一次性随机串；其后所有 iframe → host 消息必须携带；伪造/串台消息宿主侧丢弃。
// 暴露（UI 岛开发者面，P1 定稿）：window.__sk = { ready, onReady, env, manifest, host(六域直通), storage(key 级), bus, log }

(function () {
  'use strict';

  // ---- 双端协议常量（镜像 src/core/plugin/uiBridgeHost.ts UI_MSG） ----
  var MARK = '__sk'; // 消息标记字段名
  var TYPE = {
    hello: 'hello',
    boot: 'boot',
    call: 'call',
    result: 'call-result',
    sub: 'subscribe',
    unsub: 'unsubscribe',
    pub: 'publish',
    log: 'log',
    event: 'event',
    theme: 'theme',
    abort: 'abort',
  };

  var token = null;
  var plugin = {}; // boot 摘要 { id, displayName, version }
  var env = {}; // boot 环境快照 { isMac, platform }
  var readyResolve = null;
  var ready = new Promise(function (resolve) {
    readyResolve = resolve;
  });
  var onReadyCbs = [];
  var callSeq = 0;
  var pending = Object.create(null); // callId -> { resolve, reject }
  var subSeq = 0;
  var subs = []; // 订阅记录 { subId, pattern, cb }
  var unsubAll = []; // 宿主侧 subId 集合（unsubscribe 用），本地仅存 subId

  function parentPost(data) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(data, '*');
      }
    } catch (e) {
      /* iframe 已 detached：忽略 */
    }
  }

  /** 宿主发来消息：仅接受 parent 且带 __sk 标记 */
  function handleMessage(e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d[MARK] !== 1) return;
    switch (d.type) {
      case TYPE.boot: {
        if (!d.token || typeof d.token !== 'string') return;
        token = d.token;
        plugin = d.plugin || {};
        env = d.env || {};
        if (d.theme && d.theme.vars) applyTheme(d.theme.vars);
        if (readyResolve) {
          readyResolve();
          readyResolve = null;
        }
        onReadyCbs.splice(0).forEach(function (cb) {
          try {
            cb();
          } catch (err) {
            /* 忽略订阅方异常 */
          }
        });
        break;
      }
      case TYPE.result: {
        var p = pending[d.id];
        if (!p) return;
        delete pending[d.id];
        if (d.ok) p.resolve(d.value);
        else p.reject(new Error(typeof d.error === 'string' ? d.error : 'host call failed'));
        break;
      }
      case TYPE.event: {
        dispatchEventToSubs(d.eventType, d.payload, d.meta);
        break;
      }
      case TYPE.theme: {
        if (d.vars) applyTheme(d.vars);
        break;
      }
      case TYPE.abort: {
        // 宿主停止会话：拒绝所有在途调用
        Object.keys(pending).forEach(function (id) {
          pending[id].reject(new Error('host bridge aborted' + (d.reason ? ': ' + d.reason : '')));
          delete pending[id];
        });
        break;
      }
      default:
        break;
    }
  }

  window.addEventListener('message', handleMessage);

  function send(type, payload) {
    var m = { __sk: 1, type: type, token: token };
    if (payload) {
      for (var k in payload) m[k] = payload[k];
    }
    parentPost(m);
  }

  function applyTheme(vars) {
    var style = document.documentElement.style;
    for (var k in vars) {
      if (vars[k] === '') continue;
      try {
        style.setProperty(k, vars[k]);
      } catch (e) {
        /* 非法值忽略 */
      }
    }
  }

  function isPattern(p) {
    return typeof p === 'string' && p.length > 0 && p.charAt(p.length - 1) === '*';
  }
  function patternMatches(pattern, type) {
    return type.indexOf(pattern.slice(0, -1)) === 0;
  }
  function dispatchEventToSubs(eventType, payload, meta) {
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      var hit = s.pattern === eventType || (isPattern(s.pattern) && patternMatches(s.pattern, eventType));
      if (!hit) continue;
      try {
        s.cb(payload, meta || {});
      } catch (err) {
        /* 单个订阅异常不中断 */
      }
    }
  }

  function call(domain, method, args) {
    return ready.then(function () {
      var id = ++callSeq;
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        send(TYPE.call, { id: id, domain: domain, method: method, args: args || [] });
      });
    });
  }

  // ---- 对外暴露：window.__sk（UI 岛开发者面，等 boot 后可安全使用；ready/onReady 不依赖 boot） ----
  var api = {
    ready: ready,
    onReady: function (cb) {
      if (readyResolve === null) cb();
      else onReadyCbs.push(cb);
      return api;
    },
    env: env,
    manifest: plugin,
    host: {
      storage: {
        load: function (ns) {
          return call('storage', 'load', [ns]);
        },
        save: function (ns, v) {
          return call('storage', 'save', [ns, v]);
        },
        clear: function (ns) {
          return call('storage', 'clear', [ns]);
        },
      },
      clipboard: {
        writeText: function (text) {
          return call('clipboard', 'writeText', [text]);
        },
      },
      http: {
        get: function (url, opts) {
          return call('http', 'get', [url, opts]);
        },
        post: function (url, body, opts) {
          return call('http', 'post', [url, body, opts]);
        },
      },
      dialog: {
        openFile: function (opts) {
          return call('dialog', 'openFile', [opts]);
        },
      },
      ui: {
        openSettings: function (category, tab) {
          return call('ui', 'openSettings', [category, tab]);
        },
        notify: function (o) {
          return call('ui', 'notify', [o]);
        },
      },
    },
    // 自身命名空间 key 级存储（底层 modules.<pluginId>；等 boot 解析命名空间）
    storage: {
      load: function (key) {
        return call('storage', 'load', [plugin.id]).then(function (v) {
          return v && typeof v === 'object' ? v[key] : undefined;
        });
      },
      save: function (key, value) {
        return call('storage', 'load', [plugin.id]).then(function (v) {
          var o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
          var next = {};
          for (var k in o) next[k] = o[k];
          next[key] = value;
          return call('storage', 'save', [plugin.id, next]);
        });
      },
      clear: function () {
        return call('storage', 'clear', [plugin.id]);
      },
    },
    bus: {
      on: function (pattern, cb) {
        var subId = ++subSeq;
        subs.push({ subId: subId, pattern: pattern, cb: cb });
        send(TYPE.sub, { subId: subId, pattern: pattern });
        return function () {
          subs = subs.filter(function (s) {
            return s.subId !== subId;
          });
          send(TYPE.unsub, { subId: subId });
        };
      },
      emit: function (eventType, payload) {
        return call(TYPE.pub, 'emit', [eventType, payload]).catch(function () {
          /* publish 为尽力而为 */
        });
      },
    },
    log: {
      debug: function () {
        send(TYPE.log, { level: 'debug', args: Array.prototype.slice.call(arguments) });
      },
      info: function () {
        send(TYPE.log, { level: 'info', args: Array.prototype.slice.call(arguments) });
      },
      warn: function () {
        send(TYPE.log, { level: 'warn', args: Array.prototype.slice.call(arguments) });
      },
      error: function () {
        send(TYPE.log, { level: 'error', args: Array.prototype.slice.call(arguments) });
      },
    },
  };

  // env/manifest 是启动后填充的对象引用：boot 后替换引用以便消费方读最新值
  Object.defineProperty(api, 'env', {
    get: function () {
      return env;
    },
  });
  Object.defineProperty(api, 'manifest', {
    get: function () {
      return plugin;
    },
  });

  window.__sk = api;

  // ---- 握手：DOM 就绪后向宿主报告；宿主回 boot 前重试（宿主监听器注册晚于 iframe 首帧） ----
  var retries = 0;
  var MAX_RETRIES = 6;
  function hello() {
    if (token !== null) return; // 已 boot
    parentPost({ __sk: 1, type: TYPE.hello });
    retries += 1;
    if (retries < MAX_RETRIES) setTimeout(hello, 250 * retries);
  }
  function start() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', hello);
    } else {
      hello();
    }
  }
  start();
})();
