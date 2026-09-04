#!/usr/bin/env node
// scripts/sandbox-smoke.mjs
// Phase 4 Worker 沙箱桥协议冒烟：在 Node vm 中模拟沙箱运行时（sandboxRuntime.ts），
// 验证 boot → register-command → ctx.storage 读写 → run-command → clipboard 跨桥调用
// → deactivate（unregister-command）→ token 拒绝 全链路（对应 AGENTS.md 红线 20）。
// 用法：npm run plugins:sandbox:smoke（或 node scripts/sandbox-smoke.mjs）
// 期望输出：ok - ... 若干行 + SANDBOX_SMOKE_OK；失败时 process.exitCode = 1。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let code = fs.readFileSync(path.join(repo, 'src/core/plugin/sandboxRuntime.ts'), 'utf8');

// 1) 移除 TS 模块标记（真实 ?raw 注入 module worker 时合法；vm 脚本环境不接受）
code = code.replace(/^\s*export \{\};\s*$/m, '');
// 2) 将"Worker 内 blob 动态 import"替换为桩（真实环境即 import(blobUrl)，此处验证协议而非 ESM 机制）
code = code.replace(
  'mod = await import(/* webpackIgnore: true */ url);',
  'mod = await __importPlugin(url);',
);

const outbound = [];
const listeners = { message: [], error: [] };
const selfShim = {
  postMessage(msg) {
    outbound.push(msg);
  },
  addEventListener(type, fn) {
    (listeners[type] ||= []).push(fn);
  },
};

let pluginModule = {};
const sandbox = {
  self: selfShim,
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
  Blob: class {},
  AbortController,
  console,
  __importPlugin: async () => pluginModule,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

function inbound(msg) {
  for (const fn of listeners.message) fn({ data: msg });
}
const storageMap = {}; // 模拟宿主 storage 命名空间持久层（有状态，可验证写后读闭环）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failure = null;
let hostCalls = []; // 宿主收到的全部跨桥调用记录（供断言检查）

async function pump(rounds = 100) {
  for (let i = 0; i < rounds; i++) {
    // 只消费 call 并回包（模拟宿主能力面，storage 有状态）；register-*/activated/log 等
    // 应答消息保留在 outbound 队列中，供后续断言检查
    let replied = false;
    for (let j = 0; j < outbound.length; j++) {
      const m = outbound[j];
      if (m.type === 'call') {
        hostCalls.push(m.payload);
        const { id, domain, method, args } = m.payload;
        let value;
        if (domain === 'storage' && method === 'load') {
          value = storageMap[args[0]] ?? null;
        } else if (domain === 'storage' && method === 'save') {
          storageMap[args[0]] = args[1];
          value = true;
        } else if (domain === 'storage' && method === 'clear') {
          delete storageMap[args[0]];
          value = true;
        }
        outbound.splice(j, 1);
        inbound({ token: m.token, type: 'call-result', payload: { id, ok: true, value } });
        replied = true;
        break;
      }
    }
    if (replied) continue; // 回包后立刻再扫一轮（微任务可能已追加新消息）
    await sleep(2); // 让出事件循环，驱动 Worker 侧微任务链
  }
}

function assert(cond, msg) {
  if (!cond && !failure) {
    failure = msg;
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else if (cond) {
    console.log('ok -', msg);
  }
}

const T = 'tok-123456';
const seen = { activated: false, register: [], calls: [], deactivated: false, logs: [] };

// 插件：activate 注册命令并写自身存储；命令内写剪贴板；deactivate 打标记
pluginModule = {
  default: {
    async activate(ctx) {
      assert(typeof ctx.host.storage.load === 'function', 'ctx.host.storage.load 为函数');
      assert(ctx.trustLevel === 2, '沙箱 ctx.trustLevel === 2');
      await ctx.storage.save('k', 42);
      const v = await ctx.storage.load('k');
      assert(v === 42, 'ctx.storage 读写闭环');
      const off = ctx.contributions.registerCommand({
        id: 'hi',
        title: 'Hi',
        order: 5, // T8：order 应随 register-command 透传宿主
        run: async () => {
          await ctx.host.clipboard.writeText('hello-from-sandbox');
          ctx.log.info('cmd done');
        },
      });
      globalThis.__off = off;
      // T9：通配订阅 'plugin:*' 应命中后续实际事件 plugin:state-changed（按 meta.eventType 路由）
      ctx.bus.on('plugin:*', () => ctx.log.info('WILDCARD_HIT'));
    },
    async deactivate() {
      const off = globalThis.__off;
      if (off) off();
    },
  },
};

// boot
hostCalls.length = 0;
inbound({ token: T, type: 'boot', payload: { rid: 1, pluginId: 'sk-hello', manifest: { name: 'sk-hello' }, source: 'export default 1', env: { isMac: true, platform: 'darwin', version: '9.9.9' } } });
await pump();
for (const m of [...outbound]) {
  if (m.type === 'activated') seen.activated = true;
  if (m.type === 'register-command') seen.register.push(m.payload);
}
assert(seen.activated, 'boot → activated 应答');
assert(seen.register.some((r) => r.id === 'hi' && r.title === 'Hi' && r.order === 5), 'registerCommand → register-command 消息（order 透传）');
assert(hostCalls.some((c) => c.domain === 'storage' && c.method === 'load' && c.args[0] === 'sk-hello'), 'ctx.storage 落自身命名空间');

// T9：宿主推送 plugin:state-changed（实际事件名），Worker 端通配订阅 'plugin:*' 应命中
outbound.length = 0;
inbound({
  token: T,
  type: 'event',
  payload: {
    type: 'plugin:state-changed',
    payload: { id: 'sk-hello', state: 'active' },
    meta: { sourcePlugin: 'host', origin: 'host', serialized: false, eventType: 'plugin:state-changed' },
  },
});
await pump();
assert(
  outbound.some((m) => m.type === 'log' && String(m.payload?.args?.[0]).includes('WILDCARD_HIT')),
  '通配订阅 plugin:* 命中实际事件 plugin:state-changed',
);

// 宿主触发命令 run
const cmdRid = 99;
outbound.length = 0;
hostCalls.length = 0;
inbound({ token: T, type: 'run-command', payload: { rid: cmdRid, id: 'hi' } });
await pump();
let cmdOk = false;
let clipboardCall = null;
let unregCmd = null;
for (const m of [...outbound]) {
  if (m.type === 'command-result' && m.payload.rid === cmdRid) cmdOk = !!m.payload.ok;
}
clipboardCall = hostCalls.find((c) => c.domain === 'clipboard');
assert(cmdOk, 'run-command → command-result(ok)');
assert(clipboardCall && clipboardCall.method === 'writeText' && clipboardCall.args[0] === 'hello-from-sandbox', '命令内 ctx.host.clipboard.writeText 跨桥调用');

// deactivate（应运行插件 deactivate → 触发 unregister-command）
outbound.length = 0;
inbound({ token: T, type: 'deactivate', payload: { rid: 5, reason: 'test' } });
await pump();
let deactivatedOk = false;
for (const m of [...outbound]) {
  if (m.type === 'deactivated' && m.payload.rid === 5) deactivatedOk = !m.payload.error;
  if (m.type === 'unregister-command') unregCmd = m.payload;
}
assert(deactivatedOk, 'deactivate → deactivated(无 error)');
assert(unregCmd && unregCmd.id === 'hi', 'deactivate 钩子内 unregisterCommand → unregister-command');

// token 校验：伪造消息应被忽略（不应产生任何应答）
outbound.length = 0;
inbound({ token: 'wrong-token', type: 'deactivate', payload: { rid: 6 } });
await pump(5);
assert(outbound.length === 0, 'token 不符的消息被忽略');

if (!failure) console.log('\nSANDBOX_SMOKE_OK');
else process.exitCode = 1;
