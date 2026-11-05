// electron/rule-eval-window.ts
// 规则求值隔离窗口：把 `jsExpression` 规则的 `new Function` 从**主窗口**搬到一个
// 不持任何能力、不能出网的隐藏窗口里执行。
//
// 为什么必须有它（2026-11-04 审查取证）：
//   市场分发的 UI 岛可以经 `excel-copy.applyRules` 传入 `jsExpression` 规则，而
//   `src/lib/fieldProcessor.ts` 原本在主窗口用 `new Function` 求值。主窗口是
//   `contextIsolation: true` 下**唯一持有完整 `window.electronAPI`** 的上下文，
//   于是「岛声明了 db 能力」被放大成「岛可以读写白名单文件、读全部业务数据、
//   并经不限域名的 net-request 外带」。隔离窗口把这条放大链切断：
//     ① 窗口内 `window.electronAPI === undefined`（没有主 preload）；
//     ② 窗口文档 CSP 是 `connect-src 'none'`（拿不到外网，外带通道关闭）；
//     ③ 主窗口随后可以收紧到 `script-src 'self'`（见 index.html），不再需要 eval。
//
// 为什么不是自写 AST 求值器：现有规则里已经有 `fields["DNS"].split('.').slice(0,1)[0]`
//   （成员访问 + 方法链 + 下标），自写求值器要覆盖这套子集才能不破功能；隔离窗口
//   让语法 100% 不变，只把「能力」归零。
//
// 生命周期：惰性创建 → 空闲 60s 销毁 → 单次求值 2s 超时（超时直接崩掉渲染进程并重建，
//   因为同步死循环在渲染进程里没有别的打断手段）。`before-quit` 时由 main.ts 调 shutdown。

export {};

import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { handle } from './ipc-util';

/** 单次求值超时（毫秒）。超过即判定规则里有死循环，崩掉重来。 */
const EVAL_TIMEOUT_MS = 2000;
/** 空闲多久销毁窗口（毫秒）。求值窗口是重资源，不该常驻。 */
const IDLE_DESTROY_MS = 60_000;
/** 销毁后重建前的等待（毫秒）：规避 Electron「销毁后同 tick 重建 → loadURL 报已销毁」的时序问题。 */
const REBUILD_DELAY_MS = 200;
/** 单次 IPC 最大记录数。渲染层按 500 行分批，这里是主进程侧的兜底上限（不信任渲染层）。 */
const MAX_BATCH_RECORDS = 1000;
/** 单条规则 code 的最大字符数（与渲染层 sanitizeExcel 的 EC_MAX_STR 同口径）。 */
const MAX_CODE_CHARS = 20000;
/** 单个字段值的最大字符数（同上；超长直接截断，避免一次 IPC 拖走几十 MB） */
const MAX_FIELD_CHARS = 20000;

const CHANNEL = 'rule-eval-batch';

/**
 * 求值页。
 *
 * 用 `data:` URL 而不是落一个 .html 文件：静态文件在打包后需要额外 `files` 收录与路径候选，
 * 而这个页面只有十几行脚本、不含任何外部资源，`data:` 下一样能用 meta CSP 把能力收死。
 *
 * CSP 逐条理由：
 *   default-src 'none'      —— 其余一律不放（无 img/font/frame/media）
 *   script-src 'unsafe-inline' 'unsafe-eval' —— 页面脚本内联；`new Function` 是本窗口存在的**唯一目的**
 *   connect-src 'none'      —— 关键一条：窗口内 fetch/XHR 必须失败（外带通道关闭）
 *   base-uri 'none'          —— 防 <base> 改写相对地址
 */
const EVAL_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; base-uri 'none'">
<title>rule-eval</title></head><body><script>
(function () {
  var compiled = Object.create(null);
  var cspViolations = 0;

  // 违规计数：规则若试图 fetch / 加载外部资源，CSP 会拦下并在这里 +1。
  // 它同时是**运行时可观测信号**（谁在规则里偷偷连网）和冒烟的判据：
  // 只断言"表达式抛错了"是区分不了「被 CSP 拦」与「连接被拒」的。
  window.addEventListener('securitypolicyviolation', function () { cspViolations++; });

  function compile(rule) {
    // 缓存键用 **code 本身**，不是 rule.id：用户在设置页改规则时 id 不变而 code 会变，
    // 按 id 缓存会让改完的规则继续跑旧代码（静默错误，且"改完没生效"极难排查）。
    // 冒烟里"7 条夹具共用同一 id"最初就是这么红掉的。
    var key = String(rule.code);
    if (compiled[key]) return compiled[key];
    var fn = new Function('fields', '"use strict";return (' + rule.code + ')');
    if (Object.keys(compiled).length > 256) compiled = Object.create(null); // 规则数上限 64，超了说明异常
    compiled[key] = fn;
    return fn;
  }

  window.__ruleEvalBridge.onBatch(function (msg) {
    var out = new Array(msg.fields.length);
    var errors = [];
    var fn;
    try {
      fn = compile(msg.rule);
    } catch (e) {
      window.__ruleEvalBridge.postResult(msg.id, {
        ok: false,
        error: '规则编译失败：' + ((e && e.message) || String(e)),
      });
      return;
    }
    for (var i = 0; i < msg.fields.length; i++) {
      try {
        var v = fn(Object.freeze(msg.fields[i]));
        out[i] = (v === null || v === undefined) ? null : String(v);
      } catch (e) {
        out[i] = null;
        errors.push({ index: i, message: (e && e.message) ? String(e.message) : String(e) });
      }
    }
    window.__ruleEvalBridge.postResult(msg.id, {
      ok: true,
      values: out,
      errors: errors,
      cspViolations: cspViolations,
    });
  });
})();
</script></body></html>`;

/**
 * 一批的求值结果。
 * `cspViolations` 是窗口内累计的 CSP 违规次数：规则若试图连网/加载外部资源会 +1。
 * 它同时是**运行时可观测信号**与冒烟判据（区分"被 CSP 拦"与"连接被拒"）。
 */
export interface RuleEvalBatchResult {
  values: (string | null)[];
  errors: { index: number; message: string }[];
  cspViolations: number;
}

interface PendingEval {
  resolve: (v: RuleEvalBatchResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

let win: BrowserWindow | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let resultListenerReady = false;
let seq = 0;
const pending = new Map<number, PendingEval>();
/** 串行队列：窗口内是"一次一个批次"，并发下发会让两个批次的结果交错，分不清谁是谁 */
let queue: Promise<unknown> = Promise.resolve();

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleDestroy(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => destroyWindow('空闲销毁'), IDLE_DESTROY_MS);
  // 不因这个定时器拖住进程退出（Electron 主进程退出时仍有未 clear 的 timer 会延迟 quit）
  (idleTimer as unknown as { unref?: () => void }).unref?.();
}

function rejectAll(reason: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

/**
 * 放弃一个**卡在死循环里**的窗口。
 *
 * 为什么不能直接 `destroyWindow`：渲染进程正在跑同步死循环时，`w.destroy()` 会阻塞
 * 主进程（实测：日志停在 destroy 那一行，进程再也不动）—— 一次坏规则就把应用冻住，
 * 比"规则求值失败"严重得多。
 * 正确顺序是：先 `forcefullyCrashRenderer()` 杀掉渲染进程（这个调用不阻塞），
 * 再把窗口标记为废弃，1s 后（崩溃已收尾）才真正 destroy。
 */
function abandonWindow(reason: string): void {
  clearIdleTimer();
  const w = win;
  win = null;
  destroyedAt = Date.now();
  rejectAll(`规则求值窗口已销毁（${reason}）`);
  if (!w) return;
  try {
    w.webContents.forcefullyCrashRenderer();
  } catch {
    /* 已经不在了 */
  }
  const timer = setTimeout(() => {
    try {
      if (!w.isDestroyed()) w.destroy();
    } catch {
      /* 已销毁 */
    }
  }, 1000);
  (timer as unknown as { unref?: () => void }).unref?.();
}

function destroyWindow(reason: string): void {
  clearIdleTimer();
  const w = win;
  win = null;
  destroyedAt = Date.now();
  if (process.env.SK_RULE_EVAL_TRACE) {
    console.error(`[rule-eval] destroy(${reason}) win=${w ? 'live' : 'null'}`);
  }
  rejectAll(`规则求值窗口已销毁（${reason}）`);
  if (w && !w.isDestroyed()) {
    try {
      w.destroy();
    } catch {
      /* 已销毁 */
    }
  }
}

function ensureResultListener(): void {
  if (resultListenerReady) return;
  resultListenerReady = true;
  ipcMain.on('rule-eval:result', (_e: any, payload: any) => {
    const id = Number(payload?.id);
    const p = pending.get(id);
    if (!p) return; // 超时后迟到的结果：丢弃（窗口可能已被重建，不能让它污染下一批）
    pending.delete(id);
    clearTimeout(p.timer);
    const result = payload?.result;
    if (!result || result.ok !== true) {
      p.reject(new Error(String(result?.error || '规则求值失败')));
      return;
    }
    p.resolve({
      values: Array.isArray(result.values) ? result.values : [],
      errors: Array.isArray(result.errors) ? result.errors : [],
      cspViolations: Number(result.cspViolations) || 0,
    });
  });
}

async function createWindow(): Promise<BrowserWindow> {
  ensureResultListener();
  const trace = process.env.SK_RULE_EVAL_TRACE ? (m: string) => console.error(`[rule-eval] ${m}`) : null;
  trace?.('create: before new BrowserWindow');
  const w = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      preload: path.join(__dirname, 'rule-eval-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 隐藏窗口默认会被节流：定时器与 rAF 降频会让 5 万行求值慢一个数量级
      backgroundThrottling: false,
      webSecurity: true,
    },
  });
  // 窗口内不允许开新窗、不允许导航（该页不产生任何链接，纯兜底）
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e: any) => e.preventDefault());
  w.webContents.on('render-process-gone', (_e: any, details: any) => {
    if (process.env.SK_RULE_EVAL_TRACE) {
      console.error(`[rule-eval] render-process-gone(${details?.reason}) isCurrent=${win === w}`);
    }
    if (win === w) {
      win = null;
      rejectAll('规则求值窗口进程异常退出');
    }
  });
  const pageUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(EVAL_PAGE);
  trace?.('create: before loadURL');
  try {
    await w.loadURL(pageUrl);
    trace?.('create: loadURL ok');
  } catch (err) {
    // 一次重试：紧跟在"超时销毁上一个求值窗口"之后创建时，data: 加载偶发 ERR_FAILED(-2)。
    // 只重试一次 —— 真起不来（如策略禁用 data: URL）要让它显式失败，而不是无限重试。
    trace?.(`create: loadURL failed (${(err as Error)?.message})`);
    if (w.isDestroyed()) throw err;
    await w.loadURL(pageUrl);
    trace?.('create: loadURL ok (retry)');
  }
  return w;
}

/** 最近一次销毁窗口的时刻（用于规避"销毁后同 tick 重建"的 Electron 时序问题） */
let destroyedAt = 0;

async function getWindow(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win;
  win = null;
  // 实测（Electron 44）：`destroy()` 之后**同一事件循环内**新建窗口，`loadURL` 会抛
  // "Object has been destroyed" / ERR_FAILED(-2) —— 上一步的销毁还没在 Chromium 侧收尾。
  // 这不是"窗口坏了"，等一拍再建即可；只等一次，不累积延迟。
  if (destroyedAt && Date.now() - destroyedAt < 1000) {
    await new Promise<void>((resolve) => setTimeout(resolve, REBUILD_DELAY_MS));
  }
  win = await createWindow();
  return win;
}

function sanitizeRule(raw: any): { id: string; code: string } {
  const id = typeof raw?.id === 'string' && raw.id ? raw.id.slice(0, 128) : 'rule';
  const code = typeof raw?.code === 'string' ? raw.code : '';
  if (!code.trim()) throw new Error('规则 code 为空');
  if (code.length > MAX_CODE_CHARS) {
    throw new Error(`规则 code 超长（上限 ${MAX_CODE_CHARS} 字符）`);
  }
  return { id, code };
}

function sanitizeFields(raw: any): Record<string, string>[] {
  if (!Array.isArray(raw)) throw new Error('fields 必须是数组');
  if (raw.length > MAX_BATCH_RECORDS) {
    throw new Error(`单批记录数超限：${raw.length} > ${MAX_BATCH_RECORDS}`);
  }
  return raw.map((row) => {
    const out: Record<string, string> = {};
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        // 只收字符串：规则里对字段做的都是字符串运算，收别的类型只会让规则作者困惑
        if (typeof v === 'string') out[String(k)] = v.slice(0, MAX_FIELD_CHARS);
      }
    }
    return out;
  });
}

/** 真正的单批求值（串行执行） */
async function runOneBatch(
  rule: { id: string; code: string },
  fields: Record<string, string>[],
): Promise<RuleEvalBatchResult> {
  const w = await getWindow();
  if (w.isDestroyed()) throw new Error('规则求值窗口不可用');
  const id = ++seq;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // 见 abandonWindow 的注释：死循环路径**不能**同步 destroy（会冻住主进程）。
      abandonWindow('求值超时');
      reject(new Error(`规则求值超时（>${EVAL_TIMEOUT_MS}ms），已终止：规则里可能存在死循环`));
    }, EVAL_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();

    pending.set(id, { resolve, reject, timer });
    try {
      w.webContents.send('rule-eval:batch', { id, rule, fields });
    } catch (err: any) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`下发求值批次失败：${err?.message || err}`));
    }
  });
}

/**
 * 对外入口：一批字段值 + 一条规则 → 每行结果。
 * 渲染层负责按 500 行分批，本函数只保证"这一批是串行的"。
 */
export function evalJsExpressionBatch(
  rule: { id: string; code: string },
  fields: Record<string, string>[],
): Promise<RuleEvalBatchResult> {
  const task = queue.then(async () => {
    const safeRule = sanitizeRule(rule);
    const safeFields = sanitizeFields(fields);
    if (!safeFields.length) return { values: [] as (string | null)[], errors: [], cspViolations: 0 };
    const r = await runOneBatch(safeRule, safeFields);
    scheduleIdleDestroy();
    return r;
  });
  // 队列本身不能因为某次失败就永久 reject（后续批次还得能跑）
  queue = task.then(
    (): void => {},
    (): void => {},
  );
  return task;
}

/** 注册 IPC 通道（main.ts 顶层 require 时调用一次）。
 *  通道名写**字面量**而非常量：`scripts/check-ipc-contract.mjs` 只认首参是字符串字面量的
 *  包装式注册（`handle('x', ...)`），用常量会被判成"渲染层调用了未注册的通道"。 */
export function initRuleEval(): void {
  handle('rule-eval-batch', async (payload: any) => {
    const rule = payload?.rule;
    const fields = payload?.fields;
    return evalJsExpressionBatch(
      { id: String(rule?.id ?? 'rule'), code: String(rule?.code ?? '') },
      fields,
    );
  });
}

/** 退出前清理（main.ts 的 before-quit） */
export function shutdownRuleEval(): void {
  destroyWindow('应用退出');
}
