#!/usr/bin/env node
/**
 * IPC 契约自动校验（REMEDIATION_PLAN R2-4 · 防护发现项 C-02 / 替代 D-10）
 *
 * 为什么需要它
 *   渲染层能用到的 IPC 能力被拆成三份**手写清单**，必须彼此同步：
 *     ① electron/preload.ts        contextBridge 暴露给 window.electronAPI 的键
 *     ② src/types.ts               ElectronAPI 接口的属性声明
 *     ③ electron/**.ts             主进程实际注册的通道（ipcMain.handle / ipcMain.on）
 *   过去只靠人工记忆维护，于是出现了 C-02（types.ts 少 4 项声明，preload 却已暴露）——
 *   这类漂移不会报错、不会被构建拦住，只会在"运行时拿到 undefined 才报错"时暴露。
 *   本脚本把三者提取成集合并求差，任何不一致即非 0 退出。
 *
 * 它替代的是什么
 *   比手写一份「IPC 通道契约表」更可靠：契约表会随代码演进而过期，
 *   而本脚本每次运行都从源码重新提取，**结构上不可能过期**。
 *
 * 用法
 *   node scripts/check-ipc-contract.mjs        # npm run verify
 *   node scripts/check-ipc-contract.mjs --json # 机器可读输出（CI/后续工具消费）
 *
 * 维护约定
 *   - 新增 IPC 通道时的正确顺序：先写主进程 handler → 再在 preload 暴露键 →
 *     再补 src/types.ts 的 ElectronAPI 声明 → 跑 `npm run verify` 应通过。
 *   - 若校验报错，**不要**直接把差异项塞进豁免清单；豁免清单只承接
 *     语义上本就不该一一对应的项（常量、广播事件、复用通道），每项都要写理由。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_DIR = join(ROOT, 'electron');
const PRELOAD = join(ELECTRON_DIR, 'preload.ts');
const TYPES = join(ROOT, 'src', 'types.ts');
const JSON_MODE = process.argv.includes('--json');

// ---------------------------------------------------------------------------
// 豁免清单（显式维护，每项必须写理由）
// ---------------------------------------------------------------------------

/** ① 只暴露常量 / 纯本地能力，不映射任何 IPC 通道（因此不参与"通道有主"校验） */
const API_WITHOUT_CHANNEL = new Set(['platform']);

/** ② 主进程 → 渲染层的广播事件：由 webContents.send 发出，preload 用 on 订阅，
 *    不走 invoke，故不参与"通道有主"校验，单独做双向对称校验 */
const BROADCAST_EVENTS = new Set(['mail-sync-event', 'updater-event']);

/** ③ 有意复用的通道：多个 API 键映射到同一通道（一对一校验需排除） */
const SHARED_CHANNELS = new Map([['read-file', ['importExcelByPath', 'readFile']]]);

// ---------------------------------------------------------------------------
// 源码扫描工具：先做"掩码"，再在掩码上做花括号配对与匹配
// ---------------------------------------------------------------------------

/**
 * 把字符串字面量内容与注释替换为等长空格（保留换行与原始偏移），
 * 这样后续的花括号配对、正则匹配都不会被字面量里的 `{}` `(` 干扰，
 * 而需要取字面量原文时又可以用同一偏移回到 source 上取。
 */
function maskNonCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = Math.max(0, from); k < Math.min(to, n); k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      const end = e === -1 ? n : e;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c || src[j] === '\n') break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          blank(j, k);
          while (k < n && depth > 0) {
            if (src[k] === '{') depth++;
            else if (src[k] === '}') depth--;
            k++;
          }
          blank(k - 1, k);
          j = k;
          continue;
        }
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** 从 idx 起读一个字符串字面量，返回 {value, end}；非字面量返回 null */
function readStringAt(src, idx) {
  let i = idx;
  while (i < src.length && /\s/.test(src[i])) i++;
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let j = i + 1;
  let value = '';
  while (j < src.length) {
    if (src[j] === '\\') {
      value += src.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (src[j] === q) break;
    value += src[j];
    j++;
  }
  return { value, end: j + 1 };
}

/** 在掩码串上从 openIdx（内容起点）起做花括号配对，返回内容区间 [start, end) */
function matchBrace(masked, openIdx) {
  let depth = 1;
  let i = openIdx;
  while (i < masked.length && depth > 0) {
    const c = masked[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    i++;
  }
  return [openIdx, i - 1];
}

/**
 * 提取区块内部 depth===1 的成员/属性项（对象字面量的键、interface 的成员名），
 * 并给出各自的值区间（对象字面量用；interface 的方法式成员没有值区间则为 null）。
 *
 * 关键点：进入区块时**已经在第 1 层**，因此 expectKey 初始为 true；
 * 只有"第 1 层刚遇到分隔符之后"或"刚回到第 1 层"才认键，
 * 嵌套对象/参数列表里的名字（depth ≥ 2）不会误入。
 */
function extractTopLevelEntries(masked, start, end, { separators = ',;' } = {}) {
  const entries = [];
  let depth = 1;
  let expectKey = true;
  let cur = null;
  let i = start;
  while (i < end && depth >= 1) {
    const c = masked[i];
    if (depth === 1 && expectKey) {
      const m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)/.exec(masked.slice(i, i + 64));
      if (m) {
        let j = i + m[0].length;
        // 键与其值之间只可能是空白、可选标记 ?、泛型参数
        while (j < end && /[\s?<>A-Za-z0-9_$=[\]]/.test(masked[j])) j++;
        cur = { name: m[1] === 'readonly' ? null : m[1], valueStart: masked[j] === ':' ? j + 1 : null, valueEnd: null };
        if (cur.name) entries.push(cur);
        expectKey = false;
        i = j;
        continue;
      }
      // 空白不算"已消费键位"——否则区块开头的换行/缩进会把 expectKey 提前清掉
      if (/\S/.test(c)) expectKey = false;
      i++;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      // 在区块内首次遇到括号 → 该成员的值从这里开始
      if (depth === 1 && cur && cur.valueStart === null) cur.valueStart = i;
      depth++;
      i++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth--;
      i++;
      continue;
    }
    if (depth === 1 && separators.includes(c)) {
      if (cur && cur.valueEnd === null) cur.valueEnd = i;
      cur = null;
      expectKey = true;
      i++;
      continue;
    }
    i++;
  }
  if (cur && cur.valueEnd === null) cur.valueEnd = end;
  return entries;
}

/** 定位 "marker 之后的第一个 {"，返回内容区间 */
function regionAfter(source, masked, markerRe) {
  const m = markerRe.exec(masked);
  if (!m) return null;
  const braceIdx = masked.indexOf('{', m.index + m[0].length);
  if (braceIdx === -1) return null;
  const [s, e] = matchBrace(masked, braceIdx + 1);
  return [s, e];
}

// ---------------------------------------------------------------------------
// ① preload：暴露键 + 每个键实际触达的通道
// ---------------------------------------------------------------------------

function collectPreload() {
  const source = readFileSync(PRELOAD, 'utf8');
  const masked = maskNonCode(source);
  const region = regionAfter(source, masked, /exposeInMainWorld\s*\(/);
  if (!region) throw new Error('未能在 preload.ts 中定位 exposeInMainWorld({...})');

  const entries = extractTopLevelEntries(masked, region[0], region[1], { separators: ',' });

  /** @type {Map<string, {invoke: string[], send: string[], on: string[]}>} */
  const byKey = new Map();
  for (const e of entries) {
    const slice = source.slice(e.valueStart ?? 0, e.valueEnd ?? region[1]);
    const grab = (re) => [...slice.matchAll(re)].map((x) => x[1]);
    byKey.set(e.name, {
      invoke: grab(/ipcRenderer\s*\.\s*invoke\s*\(\s*['"]([^'"]+)['"]/g),
      send: grab(/ipcRenderer\s*\.\s*send\s*\(\s*['"]([^'"]+)['"]/g),
      on: grab(/ipcRenderer\s*\.\s*(?:on|once)\s*\(\s*['"]([^'"]+)['"]/g),
    });
  }
  return { keys: entries.map((e) => e.name), byKey };
}

// ---------------------------------------------------------------------------
// ② src/types.ts：ElectronAPI 接口成员
// ---------------------------------------------------------------------------

function collectTypes() {
  const source = readFileSync(TYPES, 'utf8');
  const masked = maskNonCode(source);
  const region = regionAfter(source, masked, /(?:export\s+)?interface\s+ElectronAPI\s*(?:extends[^{]*)?/);
  if (!region) throw new Error('未能在 src/types.ts 中定位 interface ElectronAPI');
  return extractTopLevelEntries(masked, region[0], region[1]).map((e) => e.name);
}

// ---------------------------------------------------------------------------
// ③ 主进程：注册的通道 + 广播事件
// ---------------------------------------------------------------------------

function collectMain() {
  const files = readdirSync(ELECTRON_DIR).filter((f) => f.endsWith('.ts'));
  const wrappers = collectWrapperNames(files);
  const channels = [];
  const broadcasts = [];
  const perFile = [];

  for (const file of files) {
    const source = readFileSync(join(ELECTRON_DIR, file), 'utf8');
    const masked = maskNonCode(source);
    const found = new Set();

    // 直接注册：ipcMain.handle('x', ...) / ipcMain.on('x', ...)
    for (const m of masked.matchAll(/ipcMain\s*\.\s*(?:handle|handleOnce|on)\s*\(/g)) {
      const lit = readStringAt(source, m.index + m[0].length);
      if (lit) found.add(lit.value);
    }

    // 包装式注册：调用点可能在**别的文件**（封装被抽到共享模块后即是常态），
    // 故包装名取自跨文件收集的 wrappers，而非本文件内的局部函数名。
    // 负向后行排除成员调用：`protocol.handle('sk-plugin', ...)` 不是 IPC 通道，
    // 而 `handle` 如今是共享包装名，用 `\b` 只能挡住词字符、挡不住 `.`（实测会误报）。
    for (const name of wrappers) {
      const callRe = new RegExp(`(?<![\\w$.])${name}\\s*(?:<[^>]*>)?\\s*\\(`, 'g');
      for (const m of masked.matchAll(callRe)) {
        const lit = readStringAt(source, m.index + m[0].length);
        if (lit) found.add(lit.value);
      }
    }

    // 广播：webContents.send('x', ...) 等
    for (const m of masked.matchAll(/\.\s*send\s*\(/g)) {
      const lit = readStringAt(source, m.index + m[0].length);
      if (lit && lit.value.includes('-')) broadcasts.push({ channel: lit.value, file });
    }

    if (found.size) {
      channels.push(...found);
      perFile.push({ file, count: found.size });
    }
  }
  return { channels: [...new Set(channels)], broadcasts, perFile };
}

/**
 * 跨文件收集「包装式注册」的函数名：函数体里出现 `ipcMain.handle/on` 的名字。
 *
 * 为什么必须跨文件：注册封装一旦被抽成共享模块（如 `electron/ipc-util.ts` 导出
 * `register` / `handle`，再由 5 个 handler 文件 import），定义处与调用处就分居两个
 * 文件。若只在单文件内找局部函数名，抽取后所有经包装注册的通道都会被误判成
 * "主进程未注册"——R2-6 抽取 ipc-util 时即实测踩到本脚本的这个耦合。
 *
 * 别名一并解析：`const { register: reg } = require('./ipc-util')` 这类重命名导入，
 * 会把 `reg` 也加进集合。别名匹配必须跑在**原文**上——掩码串里字面量内容已被抹空，
 * 模块路径匹配不到。
 */
function collectWrapperNames(files) {
  const sources = new Map();
  for (const file of files) sources.set(file, readFileSync(join(ELECTRON_DIR, file), 'utf8'));

  const wrappers = new Set();
  for (const source of sources.values()) {
    const masked = maskNonCode(source);
    // 函数声明（含泛型）/ 箭头函数赋值
    for (const m of masked.matchAll(
      /(?:function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^=]*)?=>)/g,
    )) {
      const name = m[1] || m[2];
      const body = masked.slice(m.index, m.index + 1500);
      if (/ipcMain\s*\.\s*(?:handle|handleOnce|on)\s*\(/.test(body)) wrappers.add(name);
    }
  }

  // 别名一轮：命中即足够（现实中不存在别名的别名链）
  for (const source of sources.values()) {
    for (const m of source.matchAll(
      /([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*\}?\s*(?:=[^;]*?\brequire\s*\(|from\s+)['"]\.{1,2}\//g,
    )) {
      if (wrappers.has(m[1])) wrappers.add(m[2]);
    }
  }
  return wrappers;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function diff(a, b) {
  const bs = new Set(b);
  return a.filter((x) => !bs.has(x));
}

function main() {
  const preload = collectPreload();
  const types = collectTypes();
  const main = collectMain();

  const errors = [];
  const warnings = [];
  const infos = [];

  // ---- 校验 1：preload 暴露键 ⇔ types ElectronAPI 属性（C-02 复发防护）
  const apiOnlyInPreload = diff(preload.keys, types);
  const apiOnlyInTypes = diff(types, preload.keys);
  if (apiOnlyInPreload.length || apiOnlyInTypes.length) {
    errors.push({
      title: '校验 1 · preload 暴露键与 src/types.ts 的 ElectronAPI 声明不一致',
      detail: [
        apiOnlyInPreload.length
          ? `  仅在 preload.ts 暴露、types.ts 缺声明（${apiOnlyInPreload.length} 项）：${apiOnlyInPreload.join(', ')}`
          : null,
        apiOnlyInTypes.length
          ? `  仅在 types.ts 声明、preload.ts 未暴露（${apiOnlyInTypes.length} 项）：${apiOnlyInTypes.join(', ')}`
          : null,
        '  修法：AGENTS.md §1.1 —— 新增通道必须同步 src/types.ts 的 ElectronAPI 接口。',
      ].filter(Boolean),
    });
  }

  // ---- 校验 2：preload 调用的每个通道，主进程必须有注册
  const registered = new Set(main.channels);
  const missingHandlers = [];
  const rendererChannels = new Set();
  for (const [key, v] of preload.byKey) {
    const own = [...v.invoke, ...v.send];
    for (const ch of own) rendererChannels.add(ch);
    if (API_WITHOUT_CHANNEL.has(key)) continue;
    for (const ch of own) {
      if (!registered.has(ch) && !BROADCAST_EVENTS.has(ch)) missingHandlers.push(`${key} → ${ch}`);
    }
  }
  if (missingHandlers.length) {
    errors.push({
      title: '校验 2 · 渲染层调用了未在主进程注册的通道',
      detail: [
        ...missingHandlers.map((x) => `  ${x}`),
        '  这类通道会在运行时抛出 "No handler registered"，必须补齐主进程 handler。',
      ],
    });
  }

  // ---- 校验 3：广播事件双向对称
  const broadcastMain = new Set(main.broadcasts.map((b) => b.channel));
  const preloadEvents = new Set();
  for (const [, v] of preload.byKey) v.on.forEach((c) => preloadEvents.add(c));
  for (const ch of apiOnlyInPreload.length === 0 ? [] : []) void ch; // 占位：无副作用
  const eventNoSender = diff([...preloadEvents], [...broadcastMain]);
  const eventNoListener = diff([...broadcastMain], [...preloadEvents]);
  if (eventNoSender.length || eventNoListener.length) {
    errors.push({
      title: '校验 3 · 广播事件不对称（主进程 send ↔ preload on）',
      detail: [
        eventNoSender.length ? `  preload 订阅了但主进程从不 send：${eventNoSender.join(', ')}` : null,
        eventNoListener.length ? `  主进程 send 了但 preload 不订阅：${eventNoListener.join(', ')}` : null,
        '  修法：两侧同名；若为新增事件，请同步更新本脚本的 BROADCAST_EVENTS 豁免清单。',
      ].filter(Boolean),
    });
  }

  // ---- 校验 4：主进程注册但渲染层不调用的通道（提示，不失败）
  const orphan = main.channels.filter((c) => !rendererChannels.has(c) && !BROADCAST_EVENTS.has(c));
  if (orphan.length) {
    infos.push({
      title: '校验 4 · 主进程注册但 preload 未调用的通道（信息）',
      detail: [
        ...orphan.map((c) => `  ${c}`),
        '  可能是插件运行时 / 其他窗口（如 plugin-ui-runtime）自用，或收敛后的遗留 handler。',
        '  本项不判失败，仅提示复核。',
      ],
    });
  }

  // ---- 复用通道的一致性核对
  for (const [channel, keys] of SHARED_CHANNELS) {
    const actual = keys.filter((k) => {
      const v = preload.byKey.get(k);
      return v && (v.invoke.includes(channel) || v.send.includes(channel));
    });
    if (actual.length !== keys.length) {
      errors.push({
        title: `校验 5 · 复用通道的豁免清单已过期：${channel}`,
        detail: [`  清单声明由这些键共用：${keys.join(', ')}；实际命中：${actual.join(', ') || '(无)'}`],
      });
    }
  }

  // ---- 报告
  const summary = {
    preloadKeys: preload.keys.length,
    typesProps: types.length,
    mainChannels: main.channels.length,
    broadcastEvents: main.broadcasts.length,
    errors: errors.length,
    warnings: warnings.length,
  };

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({ summary, errors, warnings, infos }, null, 2) + '\n');
  } else {
    const line = '─'.repeat(72);
    console.log(`\nIPC 契约校验（preload 键 ↔ types 声明 ↔ 主进程注册通道）\n${line}`);
    console.log(`preload 暴露键        ${String(summary.preloadKeys).padStart(4)} 个`);
    console.log(`types 声明属性        ${String(summary.typesProps).padStart(4)} 个`);
    console.log(`主进程注册通道        ${String(summary.mainChannels).padStart(4)} 个`);
    console.log(`广播事件（send）      ${String(summary.broadcastEvents).padStart(4)} 处`);
    console.log(
      `主进程注册分布        ${main.perFile
        .map((x) => `${x.file.replace(/\.ts$/, '')}:${x.count}`)
        .join('  ')}`,
    );
    console.log(line);
    for (const group of [errors, warnings, infos]) {
      for (const g of group) {
        const tag = group === errors ? '✖ 失败' : group === warnings ? '▲ 警告' : 'ℹ 信息';
        console.log(`\n${tag} · ${g.title}`);
        for (const d of g.detail) console.log(d);
      }
    }
    console.log(
      `\n${errors.length === 0 ? '✅ IPC 契约一致' : `❌ IPC 契约不一致（${errors.length} 项）`}` +
        `${warnings.length ? `，另有 ${warnings.length} 项警告` : ''}\n`,
    );
  }

  process.exit(errors.length ? 1 : 0);
}

if (!existsSync(PRELOAD) || !existsSync(TYPES)) {
  console.error('找不到 electron/preload.ts 或 src/types.ts，请在项目根目录运行。');
  process.exit(2);
}

main();
