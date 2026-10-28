// scripts/check-shop-upsert-fields.mjs
// 「店铺写入点带着已不存在的字段」的守卫（原 P1-2「全量提交漏字段」守卫的重写）。
//
// 背景变化（2026-10-22，店铺与账号物理合并）：`upsertShop` 从**全量提交**改成了**局部更新**
// （`undefined = 保持原值`，`'' = 清空`）。原来那条「每个写入点必须提交全部必填字段」
// 的判据随之失效 —— 现在漏传是"不改"，不再静默清空。
//
// 但新的静默失效出现了：字段**改名 / 删掉**（如本轮 `shopSetId` 随 `sk_shop_sets` 一起消失）后，
// 旧写入点继续传它，TS 对岛/字符串键无能为力，运行时被 `sanitizeShop` 静默丢弃 ——
// 用户以为改了，实际没写，且没有任何报错。
//
// 所以判据改成两条（清单仍从 `src/types.ts` 读，**不写死**）：
//   ① 每处字面量写入点的键必须都在对应输入类型里（多出来的 = 改名 / 已删字段）
//   ② 每处写入点至少传一个字段（`id` 不算），否则这次调用什么都不会改
// 旧的 `shopSetId` 就是这么被自动抓出来的，以后删字段同样不用回来改脚本。
//
// 2026-10-22 物理合并后补充：店铺行上的字段（邮箱 / 企业 / 工具 / 凭证）改走 `shopAccountUpsert`
// （局部更新），编辑器把 payload 写成**带类型标注的字面量**（`const payload: ShopAccountUpsertInput = {`）。
// 两类写入点一并纳入，各自对各自的输入类型校验：
//   · `shopUpsert({...})` 系（岛 / 宿主内建页 / 直连桥）→ 键必须都在 `ShopUpsertInput`
//   · `shopAccountUpsert({...})` 与 `const x: ShopAccountUpsertInput = {` → 键必须都在 `ShopAccountUpsertInput`
// 空转守卫看两类合计：一处都扫不到 = 正则失效，判失败。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const TYPES_FILE = path.join(ROOT, 'src', 'types.ts');
const SCAN_DIRS = ['src', 'ui-plugins'];
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.vue']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build', 'coverage']);

/** 从 `{` 起做括号配对扫描，返回块内容（不含最外层花括号）与结束下标 */
function scanBlock(src, openIdx) {
  let depth = 0;
  let quote = null; // ' " `
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i + 2);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 ? src.length : close + 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { body: src.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

/** 去掉注释（块内容的行注释 / 块注释），避免注释里的 `key:` 被当成字段 */
function stripComments(s) {
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += s[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i + 2);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const close = s.indexOf('*/', i + 2);
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** 取**顶层**的键名（深度 1；嵌套对象里的键不算——本脚本只查扁平 payload）。
 *  只认 `key:` / `key?:` 命名写法 —— 简写 `{ name }` 与三元值里的裸标识符在深度 0 无法
 *  区分，故调用点要求写 `name: name`（顺便更可读）。 */
function topLevelKeys(body) {
  const src = stripComments(body);
  const keys = new Set();
  let depth = 0;
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') depth -= 1;
    else if (depth === 0) {
      // 顶层字段名：`key:` 或 `key?:`（接口里）
      const m = /^([A-Za-z_$][\w$]*)\s*(\?)?\s*:/.exec(src.slice(i));
      if (m) {
        keys.add(m[1]);
        i += m[0].length - 1;
      }
    }
  }
  return keys;
}

/** 从 src/types.ts 读出指定接口的**全部**字段（必填 + 可选） */
function interfaceFields(name) {
  const src = fs.readFileSync(TYPES_FILE, 'utf8');
  const at = src.search(new RegExp(`interface\\s+${name}\\s*\\{`));
  if (at < 0) throw new Error(`在 src/types.ts 里找不到 interface ${name}`);
  const open = src.indexOf('{', at);
  const block = scanBlock(src, open);
  if (!block) throw new Error(`${name} 的花括号不配对`);
  const src2 = stripComments(block.body);
  const keys = [];
  const re = /^\s*([A-Za-z_$][\w$]*)\s*(\?)?\s*:/gm;
  let m;
  while ((m = re.exec(src2))) keys.push(m[1]);
  return keys;
}

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (EXTS.has(path.extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}

const SHOP_FIELDS = interfaceFields('ShopUpsertInput');
const ACCOUNT_FIELDS = interfaceFields('ShopAccountUpsertInput');
const knownShop = new Set(SHOP_FIELDS);
const knownAccount = new Set(ACCOUNT_FIELDS);
const files = SCAN_DIRS.map((d) => path.join(ROOT, d)).flatMap((d) => walk(d));

/**
 * 写入点的几种写法都要认（漏认一个 = 那个写入者不受守卫约束）：
 *   · 岛：`shopUpsert({...})`（各岛 src/api.js 里的同名封装）
 *   · 宿主内建页：`shopApi.upsert({...})`
 *   · 直接走桥的岛：`db.call('shop', 'upsert', {...})`
 *   · 物理合并后的店铺行写入：`shopAccountUpsert({...})`
 *   · 编辑器带类型标注的 payload 字面量：`const x: ShopAccountUpsertInput = {`
 */
const SHOP_MARKERS = ['shopUpsert(', 'shopApi.upsert(', "call('shop', 'upsert',", 'call("shop", "upsert",'];
const ACCOUNT_MARKERS = ['shopAccountUpsert('];
/** 形如 `const payload: ShopAccountUpsertInput = {` —— 从 `{` 起扫块 */
const ACCOUNT_TYPED_RE = /:\s*ShopAccountUpsertInput\s*=\s*\{/g;

/** 从 marker 结束处往后找**第一个** `{`；先遇到 `)` 说明这次调用没有字面量参数（透传） */
function objectStartAfter(src, from) {
  for (let i = from; i < src.length && i < from + 80; i++) {
    if (src[i] === ')') return -1;
    if (src[i] === '{') {
      // 形如 `call('shop', 'upsert', {` 中间隔着字符串字面量也算命中；
      // 但 `shopUpsert(payload)` 这种到 `)` 才结束的上面已排除
      return i;
    }
  }
  return -1;
}

/** 每处带字面量的店铺写入点 */
const sites = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const marker of SHOP_MARKERS) {
    let from = 0;
    for (;;) {
      const at = src.indexOf(marker, from);
      if (at < 0) break;
      from = at + marker.length;
      const open = objectStartAfter(src, from);
      if (open < 0) continue;
      const block = scanBlock(src, open);
      if (!block) continue;
      const line = src.slice(0, at).split('\n').length;
      sites.push({ kind: 'shop', file: path.relative(ROOT, file), line, keys: topLevelKeys(block.body) });
      from = block.end;
    }
  }
  for (const marker of ACCOUNT_MARKERS) {
    let from = 0;
    for (;;) {
      const at = src.indexOf(marker, from);
      if (at < 0) break;
      from = at + marker.length;
      const open = objectStartAfter(src, from);
      if (open < 0) continue;
      const block = scanBlock(src, open);
      if (!block) continue;
      const line = src.slice(0, at).split('\n').length;
      sites.push({ kind: 'account', file: path.relative(ROOT, file), line, keys: topLevelKeys(block.body) });
      from = block.end;
    }
  }
  ACCOUNT_TYPED_RE.lastIndex = 0;
  for (;;) {
    const m = ACCOUNT_TYPED_RE.exec(src);
    if (!m) break;
    const open = src.indexOf('{', m.index);
    const block = scanBlock(src, open);
    if (!block) continue;
    const line = src.slice(0, m.index).split('\n').length;
    sites.push({ kind: 'account', file: path.relative(ROOT, file), line, keys: topLevelKeys(block.body) });
    ACCOUNT_TYPED_RE.lastIndex = block.end;
  }
}
sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

const problems = [];
for (const s of sites) {
  const known = s.kind === 'shop' ? knownShop : knownAccount;
  const typeName = s.kind === 'shop' ? 'ShopUpsertInput' : 'ShopAccountUpsertInput';
  const unknown = [...s.keys].filter((k) => !known.has(k));
  if (unknown.length) {
    problems.push(
      `${s.file}:${s.line} 提交了 ${typeName} 里不存在的字段：${unknown.join(' / ')}` +
        `（改名或已删的字段会被静默丢弃，用户以为改了、实际没写）`,
    );
  }
  const effective = [...s.keys].filter((k) => k !== 'id');
  if (!effective.length) {
    problems.push(`${s.file}:${s.line} 这次调用只传了 id，一个可写字段都没有 —— 等于什么都没改`);
  }
}

console.log(`ShopUpsertInput 字段（取自 src/types.ts）：${SHOP_FIELDS.join(', ')}`);
console.log(`ShopAccountUpsertInput 字段（取自 src/types.ts）：${ACCOUNT_FIELDS.join(', ')}`);
console.log(`扫描到 ${sites.length} 处带字面量的店铺写入点：`);
for (const s of sites) console.log(`  · [${s.kind}] ${s.file}:${s.line}`);

// ⭐ 空转守卫：一个调用点都没扫到 = 正则失效或文件搬走了，这时"全绿"毫无意义
if (!sites.length) {
  problems.push('一处调用点都没扫到（正则失效 / 目录搬走了）—— 守卫不能空转');
}

if (problems.length) {
  for (const p of problems) console.error(`❌ ${p}`);
  console.error(
    '\nupsertShop 是局部更新（缺省 = 保持原值）：字段改名 / 删除后，旧写入点必须跟着改；' +
      '否则它传的键会被静默丢弃。',
  );
  process.exit(1);
}
console.log('✅ 店铺写入点没有陈旧字段，且每次至少改一个字段（局部更新语义）');
