// 插件下记（内建 → UI 岛）的结构化守卫。
//
// 背景（2026-09-21 真实故障）：order-insight 的 UI 岛早就建好并可从市场安装，
// 但 modules.config.json 的 standard/pro 预设里仍登记着同名内建视图包。
// managerDiscover.discover() 先按预设把内建 id 写进 records，随后 registerUiIsland()
// 见 records.has(id) 就直接 return —— 岛装上了、市场显示"已安装"，却永远没有侧栏入口，
// 只在 console 留一条 warn（AGENTS 红线 23）。
//
// 这三条断言把"下记"这个动作钉死成可回归的结构约束：
//   1) 预设清单与 ui-plugins/ 目录名不得有交集（下记必须真实发生）；
//   2) 岛源码里的 db op 调用必须全部在 manifest 里声明（否则运行时才报越权）；
//   3) 岛的 manifest.name 必须与目录名一致（否则市场/manifest 两处 id 漂移）。
//
// 另有一组反向断言（2026-09-22 补）：内建下记后，岛的**能力缺口**不会让它变"死件"却无提示。
//   "调用 ⊆ 声明"只管越权，管不了"声明了却从没调用" —— 后者是下记后的主要回退形态，故另立一组。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

/** ui-plugins/ 下的岛目录名（= 岛屿 id） */
const islandIds = (): string[] => {
  const dir = resolve(root, 'ui-plugins');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith('.') && statSync(resolve(dir, n)).isDirectory())
    .sort();
};

/** 递归列出目录下全部文件 */
const walk = (dir: string, acc: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
};

type IslandManifest = {
  name?: string;
  version?: string;
  entry?: string;
  capabilities?: Array<{ id?: string; domains?: string[]; actions?: string[] }>;
};

const readManifest = (id: string): IslandManifest =>
  JSON.parse(readFileSync(resolve(root, 'ui-plugins', id, 'manifest.json'), 'utf-8'));

/**
 * 该路径是否被 .gitignore 忽略（**纯规则判定**）。
 * - true  = 被忽略（`git check-ignore` 退出码 0）
 * - false = 未被忽略（退出码 1）
 * - null  = 无法判定（不是 git 工作树 / 没装 git；退出码 128 等）→ 调用方按"跳过"处理，
 *           别把守卫变成"必须处于某个环境"的硬依赖
 *
 * ⚠ 必须带 `--no-index`：默认行为会先查索引，而**已被跟踪的文件永远不报"被忽略"** ——
 * 于是对已入库的路径，这个守卫会无条件通过（等于没守）。本守卫要的正是"按规则判断"，
 * 与当前是否已跟踪无关。这个坑是实测出来的：去掉 .gitignore 例外后断言仍未变红。
 */
const isGitIgnored = (relPath: string): boolean | null => {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', '--', relPath], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch (e) {
    return (e as { status?: number }).status === 1 ? false : null;
  }
};

describe('内建预设不得占用 UI 岛的 id（AGENTS 红线 23）', () => {
  const cfg = JSON.parse(readFileSync(resolve(root, 'modules.config.json'), 'utf-8')) as {
    profiles?: Record<string, string[]>;
    enabledModules?: string[];
  };

  it('modules.config.json 声明的模块 id 与 ui-plugins/ 目录名无交集', () => {
    const declared = [
      ...Object.values(cfg.profiles ?? {}).flat(),
      ...(cfg.enabledModules ?? []),
    ];
    const ids = islandIds();
    expect(ids.length).toBeGreaterThan(0); // 至少存在一个岛，否则本断言空转
    expect(declared.filter((id) => ids.includes(id))).toEqual([]);
  });

  it('构建产物注册表中不自带任何 UI 岛（下记后一律由市场安装）', () => {
    const reg = resolve(root, 'src/registry.generated.ts');
    if (!existsSync(reg)) return; // 未构建时跳过，避免把守卫变成构建步骤的硬依赖
    const text = readFileSync(reg, 'utf-8');
    const leaked = islandIds().filter((id) => text.includes(`'${id}'`));
    expect(leaked).toEqual([]);
  });
});

/**
 * 剥掉注释（守卫必须看真实代码：注释里出现的同名字符串会让断言假通过 —— 见 §reclassify 注释）。
 *
 * ⚠️ 必须**逐字符扫描**，不能写成两条正则（块注释一条 + 行注释一条）：
 * 行注释里出现的「斜杠 + 星号」会被正则当成块注释开头，一路吞到**很后面**的下一个
 * 「星号 + 斜杠」，中间的真实代码整段消失。实测（2026-09-27）：ae-profit/src/api.js 第 3 行
 * 注释里写了 `@/core/services/` 再跟一个通配星号，就是这么把第 8 行的 `const DOMAIN_AE = 'ae'`
 * 吃掉的 —— 症状是「守卫把一个域解析成了常量名 `DOMAIN_AE` 本身」，看起来像 manifest 越权。
 * 字符串字面量（含模板串）要跳过，否则串里的行注释 / 块注释标记同样会误判。
 */
const stripComments = (s: string): string => {
  let out = '';
  let i = 0;
  let start = 0; // 上一段"确定要保留"的起点（整段 slice 追加，别逐字符 +=）
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < s.length && s[i] !== c) i += s[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      out += s.slice(start, i);
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl;
      start = i;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      out += s.slice(start, i);
      const close = s.indexOf('*/', i + 2);
      const end = close === -1 ? s.length : close + 2;
      // 块注释内部的换行要按原数量补回：行首锚点（如 hostDomainOps 的 `^ {4}key:`）依赖它
      const inner = s.slice(i, end);
      let n = 0;
      for (let k = inner.indexOf('\n'); k !== -1; k = inner.indexOf('\n', k + 1)) n++;
      i = end;
      start = i;
      if (n > 0) out += '\n'.repeat(n);
      continue;
    }
    i++;
  }
  return out + s.slice(start);
};

/**
 * 剥注释后的文件文本（**按路径缓存**）。
 * 岛产物是几百 KB 的 bundle，而同一个文件会被"正向越权检查 / 反向能力缺口 / 各岛专属断言"
 * 反复读 —— 不缓存时 `pluginTriage.spec.ts` 单文件要跑 30 s 以上，会把并发跑的其他测试
 * 挤到 5 s 超时（实测 2026-09-27：全量跑只剩本文件红，单跑却全绿，看起来像"随机失败"）。
 * 同一次运行内源文件不会变，缓存是安全的。
 */
const strippedCache = new Map<string, string>();
const readStripped = (file: string): string => {
  const hit = strippedCache.get(file);
  if (hit !== undefined) return hit;
  const text = stripComments(readFileSync(file, 'utf-8'));
  strippedCache.set(file, text);
  return text;
};

/** 递归列目录的结果缓存（同上：一次运行内目录结构不变） */
const fileListCache = new Map<string, string[]>();
const walkCached = (dir: string): string[] => {
  const hit = fileListCache.get(dir);
  if (hit) return hit;
  const list = walk(dir);
  fileListCache.set(dir, list);
  return list;
};

/**
 * 该岛「文本检查」该扫哪个目录：**有 `src/` 就只看 `src/`，没有才看 `dist/`**。
 *
 * 为什么不是两个都扫（并集更保险，但本仓库付不起这个代价）：
 *   ① **dist/ 不入库**（.gitignore 通了配）。新克隆 / CI 上只有 `src/` —— 守卫必须在那种
 *      环境里照样工作，把 dist 设成必需反而是把守卫变成"只在本机成立"。
 *   ② 构建型岛的 dist 是 `src/` 的**派生物**（含整个 Vue runtime，product-library 261 KB
 *      vs src 41 KB）。文本检查该看人写的那份。
 *   ③ 实测（2026-09-27）：本机文件读取很慢（36 个文件 414 KB 要 683 ms），全量并发跑时
 *      还会再放大数倍。并集扫描让 `pluginTriage.spec.ts` 从 2.2 s 涨到 17 s，并直接把并发
 *      跑的其他 spec 挤到 5 s 超时（表现为"单跑全绿、全量红"，极易误判成随机失败）。
 * 残余缺口（已知、接受）：dist 里有而 src 里没有的调用不被这里检查 —— 对 product-library
 * 由下面那条「dist 与 src 的 db 调用点必须一致」断言补上；其余构建型岛暂无覆盖。
 */
const islandTextDir = (id: string): string => {
  const src = resolve(root, 'ui-plugins', id, 'src');
  return existsSync(src) ? src : resolve(root, 'ui-plugins', id, 'dist');
};

/** 某个岛的源码文本（`islandTextDir` 决定扫哪个目录），已剥注释 */
const islandSource = (id: string): string => {
  const dir = islandTextDir(id);
  if (!existsSync(dir)) return '';
  const parts: string[] = [];
  for (const f of walkCached(dir)) {
    if (/\.(js|mjs|ts|vue)$/.test(f)) parts.push(readStripped(f));
  }
  return parts.join('\n');
};

/**
 * 岛 api 层里「一次 db 调用」的形态描述。
 * `call` 必须**带 g 标志**，且第 1 捕获组是 **op 名字面量** —— 两个方向的比对全靠它：
 *   · 正向「调用 ⊆ 声明」（越权）；
 *   · 反向「声明的每个 op 都真被调用」（能力缺口）。
 * op 名若被拼成变量传进去（`helper(op)`），两组断言都会静默失效。
 *
 * ⚠️ 引号必须写成 `['"]`：vite 工程的产物经 Rollup 后，**单引号会被改成双引号**
 * （实测 product-library 的 dist 里全是 `plib("list"`）。只认单引号 = 对构建型岛零命中。
 */
type ApiBinding = { domain: string; call: RegExp };

/** op 名字面量（单/双引号都认） */
const OP_LIT = `['"]([A-Za-z][A-Za-z0-9]*)['"]`;

/**
 * 从岛的 api 层解析 db 调用形态（域 + 调用点正则）。
 *
 * 候选路径必须覆盖 **三种** 既有写法，否则守卫会**整岛静默跳过**（外层 `bindings.length === 0`
 * 就 return）：① 无构建步骤的岛与新式 vite 岛：`export const oi = (op, payload) => db('shop-accounts', op, payload)`，
 * 调用点写作 `oi('list', …)`；
 *   ② ae-profit：`dbCall(DOMAIN_AE, 'summary', …)` —— 域是**第一个实参**（另需解析 `const DOMAIN_AE = 'ae'`）；
 *   ③ shop-accounts：`dbCall('summary', …)` —— 域硬编码在 bridge.js 的 `host.db.call('shop-accounts', …)`。
 *
 * 历史坑（2026-09-27 发现，实测）：候选路径原先是 `dist/api.js` + `src/api.ts`，而两个 vite
 * 工程岛（ae-profit / shop-accounts）的源码是 `src/api.js` —— 它们连同其 manifest 一起长期
 * 逃过这组守卫：断言年年全绿、实际覆盖为零。**「守卫零命中」和「守卫通过」在报告里长得一模一样**，
 * 所以下面每个岛都以 `expect(bindings.length).toBeGreaterThan(0)` 自证不是空转。
 */
const apiBindings = (id: string): ApiBinding[] => {
  const dir = resolve(root, 'ui-plugins', id);
  const out: ApiBinding[] = [];

  // ① 形态：helper 直接绑域（`= (…) => db('domain', …)`）
  for (const rel of ['dist/api.js', 'src/api.js', 'dist/api.ts', 'src/api.ts']) {
    const file = resolve(dir, rel);
    if (!existsSync(file)) continue;
    const text = readStripped(file);
    for (const m of text.matchAll(
      /export const (\w+)\s*=\s*\([^)]*\)\s*=>\s*db\(\s*['"]([^'"]+)['"]/g,
    )) {
      out.push({ domain: m[2], call: new RegExp(`\\b${m[1]}\\(${OP_LIT}`, 'g') });
    }
    // ② 形态：域是 dbCall 的第一个实参，值是常量名
    const consts = new Map(
      [...text.matchAll(/const\s+(\w+)\s*=\s*['"]([^'"]+)['"]/g)].map((m) => [m[1], m[2]]),
    );
    for (const m of text.matchAll(/\bdbCall\(\s*(\w+)\s*,\s*['"]([^'"]+)['"]/g)) {
      out.push({
        domain: consts.get(m[1]) ?? m[1],
        call: new RegExp(`\\bdbCall\\(\\s*${m[1]}\\s*,\\s*${OP_LIT}`, 'g'),
      });
    }
  }

  // ③ 形态：桥里硬编码域，api 层只传 op（shop-accounts）
  const bridge = resolve(dir, 'src/bridge.js');
  if (existsSync(bridge)) {
    const text = readStripped(bridge);
    for (const m of text.matchAll(/host\.db\.call\(\s*['"]([^'"]+)['"]/g)) {
      out.push({ domain: m[1], call: new RegExp(`\\bdbCall\\(${OP_LIT}`, 'g') });
    }
  }
  return out;
};

/**
 * 宿主 DB_OPS 里某个域的**整块源码**（已剥注释）。
 *
 * ⚠️ 域键有两种写法，两种都要认：含 `-` 的 id 必须加引号（`'shipping-rate': {`），
 * 单个词的实体名则是裸标识符（`product: {` —— ADR-002 N4 要求主数据域用实体名，
 * 不用插件 id）。只认带引号那种时 `hostDomainBlock('product')` 会返回空串，
 * 而调用方多半写成 `expect(ops.length).toBeGreaterThan(0)` —— 那样只是变红，
 * 看不出真正的病因是"域键写法没覆盖"（2026-09-27 实测踩到）。
 */
const hostDomainBlock = (domain: string): string => {
  const text = readFileSync(resolve(root, 'src/core/plugin/host.ts'), 'utf-8');
  const hit = new RegExp(`\n {2}'?${domain}'?: \\{`).exec(text);
  if (!hit) return '';
  const rest = text.slice(hit.index + 1);
  const end = rest.indexOf('\n  },\n');
  return stripComments(end === -1 ? rest : rest.slice(0, end));
};

/** 宿主 DB_OPS 中某个域登记的全部 op（权威来源：src/core/plugin/host.ts） */
const hostDomainOps = (domain: string): string[] =>
  [...hostDomainBlock(domain).matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);

/** DB_OPS 对象体（从 `const DB_OPS … = {` 到下一个顶格 `};`）。只在体内找域名，避免误收嵌套对象。 */
const dbOpsBody = (): string => {
  const text = readFileSync(resolve(root, 'src/core/plugin/host.ts'), 'utf-8');
  const start = text.indexOf('const DB_OPS');
  if (start === -1) throw new Error('host.ts 里找不到 DB_OPS 声明');
  const end = text.indexOf('\n};', start);
  if (end === -1) throw new Error('DB_OPS 对象没有找到收尾的 "};"');
  return text.slice(start, end);
};

/** DB_OPS 里登记的全部域 key（两种域键写法都认，理由同 hostDomainBlock） */
const hostDomains = (): string[] =>
  [...dbOpsBody().matchAll(/\n {2}'?([a-z][a-z0-9-]*)'?: \{/g)].map((m) => m[1]);

// 本组每个用例都要把该岛的整个 `src/`（或 dist/）读成文本再正则扫描 —— 数据量不大
// （全部岛合计约 700 KB），但**本机文件读取很慢**，单独跑 0.3–0.6 s/岛，全量并发跑会放大数倍。
// 默认 5 s 会在并发时随机踩线（表现是"单跑绿、全量红"）。这里给足余量：断言本身仍然是硬的，
// 变慢只会让它晚一点出结果，不会把失败变成通过。
describe('UI 岛的 db 能力调用必须全部在 manifest 中声明', { timeout: 20000 }, () => {
  it.each(islandIds())('%s：能力域与 op 均被 capabilities 覆盖', (id) => {
    const bindings = apiBindings(id);
    const dbCap = (readManifest(id).capabilities ?? []).find((c) => c.id === 'db');
    if (!dbCap) {
      // 声明了 db 能力却解析不出任何绑定形态 = 守卫看不见这个岛，必须报出来
      expect(bindings.length).toBe(0);
      return;
    }
    // 有 db 能力就必须能解析出绑定形态，否则本岛整段守卫是空转（历史坑见 apiBindings 注释）
    expect(bindings.length).toBeGreaterThan(0);

    const declaredDomains = new Set(dbCap.domains ?? []);
    const declared = new Set(dbCap.actions ?? []);

    // 只扫 `islandTextDir(id)` 一个目录（有 src 就只看 src）：理由见该函数注释 ——
    // 并集扫描会让本文件在全量并发跑时把其他 spec 挤到超时。
    const dir = islandTextDir(id);
    if (!existsSync(dir)) return;

    const usedDomains = new Set<string>();
    const usedOps = new Set<string>();
    for (const f of walkCached(dir)) {
      if (!/\.(js|mjs|ts|vue)$/.test(f)) continue;
      // 先剥注释：注释里写的调用字样不是"真调用"。不剥的话，注释能把断言喂饱 —— 假通过。
      const text = readStripped(f);
      for (const { domain, call } of bindings) {
        for (const m of text.matchAll(call)) {
          usedDomains.add(domain);
          usedOps.add(m[1]);
        }
      }
    }

    expect([...usedDomains].filter((d) => !declaredDomains.has(d))).toEqual([]);
    expect([...usedOps].filter((op) => !declared.has(op))).toEqual([]);
  });
});

describe('UI 岛的 manifest.name 与目录名一致', () => {
  it.each(islandIds())('%s', (id) => {
    expect(readManifest(id).name).toBe(id);
  });
});

describe('岛的运行入口必须真实入库（防 .gitignore 静默吞掉源码）', () => {
  // 背景（2026-09-22 H-04）：`.gitignore` 的 `dist/` 通配会匹配**任意层级**的 dist 目录。
  // excel-copy 是「无构建步骤」的岛（shipping-rate 已于 2026-10-15 回收为内建模块，不再属此类）—— 没有 package.json / vite.config，
  // 源码直接手写在 dist/ 下，manifest.entry 指向 ./dist/index.html。
  // 于是 `git add -A` 只收录了 manifest.json + README.md，仓库里长期存着两个
  // 「entry 指向不存在文件」的坏岛（其中 order-insight 1.2.0 已发布、仓库里却从来没有它的源码 ——
  // 该岛已于 2026-10-05 整体下架，但**这类缺陷与它无关**，故守卫保留）。
  // 该缺陷在本地磁盘上完全看不出来（文件都在），只在克隆 / 回滚 / 换机后才暴露 —— 故必须由守卫钉住。
  // 两种形态的"源码真相"位置不同，判据也必须分开（当前实测两者完全对应）：
  //   有 package.json ⟺ 有 src/ ⟺ dist/ 是构建产物（忽略 dist、提交 src 才对）
  //   无 package.json ⟺ 无 src/ ⟺ dist/ 就是源码（忽略 dist = 丢源码）
  it.each(islandIds())('%s：源码真相未被 .gitignore 吞掉', (id) => {
    const abs = resolve(root, 'ui-plugins', id);
    if (existsSync(resolve(abs, 'package.json'))) {
      // 构建产物型：随包提交的是 src/（dist/ 由发布脚本现场构建）
      expect(existsSync(resolve(abs, 'src'))).toBe(true);
      expect(isGitIgnored(`ui-plugins/${id}/src/`)).not.toBe(true);
      return;
    }
    // 无构建步骤型：源码就在 dist/ 下，manifest.entry 也指向它 —— 必须真实入库
    const entry = readManifest(id).entry;
    expect(typeof entry).toBe('string');
    const rel = `ui-plugins/${id}/${String(entry).replace(/^\.\//, '')}`;
    expect(existsSync(resolve(root, rel))).toBe(true);
    expect(isGitIgnored(rel)).not.toBe(true);
  });

  it('至少存在一个「无构建步骤」的岛，且其 dist/ 全部未被忽略', () => {
    // 这一条是上一条的反向兜底：若哪天所有岛都改成带构建脚本，
    // 上面那个分支就再也不会被执行，守卫会静默失效 —— 这里把它钉住。
    const noBuild = islandIds().filter(
      (id) => !existsSync(resolve(root, 'ui-plugins', id, 'package.json')),
    );
    expect(noBuild.length).toBeGreaterThan(0); // 当前为 excel-copy（order-insight 随岛下架、shipping-rate 于 2026-10-15 回收为内建）
    expect(noBuild.filter((id) => isGitIgnored(`ui-plugins/${id}/dist/`) === true)).toEqual([]);
  });
});

// ~~`order-insight 岛已对齐内建版能力（缺口不得再悄悄回退）`~~ **整块已删（2026-10-05）**：
// 那组反向断言（`REQUIRE_OPS` 七项必须被岛源码真实调用 / 对账字段名 / `reclassify` 必带指纹）
// 服务的对象是**市场分发的那个岛**——它已整体下架，发货台由 `src/modules/today/**` 在宿主里做，
// 岛源码不再存在于仓库 ⇒ 断言无对象、留着只会变红或空转。
// 这些**坑**没有跟着消失，它们已经变成内建页的守卫：拿货单编辑/单价回填/取消忽略/店铺分摊的
// 接线在 `today:ui` 的假桥冒烟里逐条断言（见 `scripts/today-ui-smoke.mjs` 的 `purchase` / `classify`
// 两段）；字段名口径（`purchaseCents` / `paidCents` / `refundCents` / `balanceCents` / `orderCount`）
// 由 `src/modules/today/purchase.ts` 直接以 TS 类型钉住（编译期，比扫字符串更强）。

describe('excel-copy 岛已对齐内建版能力（下记后不得悄悄缩水）', () => {
  // 背景（2026-09-22）：excel-copy（TV模版）内建视图包下记后，功能由 ui-plugins/excel-copy 独家提供。
  // 该岛有两处**必须走宿主**的硬约束，且都属于"违反了也不报错、只是功能不对"的类型：
  //   ① Excel 解析：岛内不打包 xlsx（宿主已有解析器，重复引入会让两端口径漂移）；
  //   ② 规则求值：iframe 的 CSP 是 `script-src 'self'`，**没有 unsafe-eval**，
  //      jsExpression 规则用的是 new Function —— 岛内根本无法执行。
  // 因此下面既查"宿主域每个 op 都被用上"，也查"岛内不得自行 eval / 引 xlsx"。
  const ISLAND = 'excel-copy';

  it('宿主 excel-copy 域的每个 op 都被岛真实调用（"声明了却没用"就是能力缺口）', () => {
    const ops = hostDomainOps(ISLAND);
    expect(ops.length).toBeGreaterThan(0);
    const text = islandSource(ISLAND);
    expect(ops.filter((op) => !new RegExp(`\\bec\\('${op}'`).test(text))).toEqual([]);
  });

  it('岛内不得出现 eval / new Function（iframe CSP 禁 eval，规则求值必须在宿主）', () => {
    const text = islandSource(ISLAND);
    expect(/\bnew\s+Function\s*\(/.test(text)).toBe(false);
    expect(/(^|[^.\w])eval\s*\(/m.test(text)).toBe(false);
  });

  it('规则求值确实走宿主 applyRules', () => {
    expect(/\bec\('applyRules'/.test(islandSource(ISLAND))).toBe(true);
  });

  it('配置命名空间为 excel-copy（与内建 modules.excel-copy 同源 → 老配置自动继承）', () => {
    const bridge = readFileSync(resolve(root, 'ui-plugins', ISLAND, 'dist/bridge.js'), 'utf-8');
    expect(bridge).toMatch(/export const NS = 'excel-copy'/);
  });

  it('岛内不引入 xlsx/SheetJS（解析在宿主完成）', () => {
    const text = islandSource(ISLAND);
    expect(/from\s+['"](xlsx|sheetjs)['"]/i.test(text)).toBe(false);
    expect(/require\(\s*['"](xlsx|sheetjs)['"]\s*\)/i.test(text)).toBe(false);
  });

  it('模板保存必须连 name 一起落库（只写 content 会出现"名字回退、内容却是新的"半保存）', () => {
    const store = readFileSync(resolve(root, 'ui-plugins', ISLAND, 'dist/store.js'), 'utf-8');
    const m = store.match(/export async function saveTemplateToFile[\s\S]*?\n\}/);
    expect(m).toBeTruthy();
    expect(m![0]).toContain('name: tpl.name');
  });
});

describe('无忧物流运费：岛通路已整域删除，且不得复活（单源= 不许出现第二处实现）', () => {
  // 2026-10-15 二次收口：首轮回收只把 `host.ts` 该域改成薄委托（留给"市场里已装旧岛的用户"），
  // 本轮按"项目尚未上线、没有这批用户"把**整条岛通路**拿掉：host.ts 的 DB_OPS 域、
  // 市场 catalog 条目与 zip、OrderCostView 里读旧岛 storage 键的回落分支。
  //
  // 为什么必须留守卫（而不是把这段删干净）：这个域一旦被加回来，**症状不是报错**，
  // 是同一份报价单算出两个数（岛桥与内建页各一份解析/计价，口径漂移 ⇒ 静默错价）。
  // 且它长得"很合理"（薄委托 + 有注释解释为什么保留），review 时极易放过。
  // 判据钉的是"域不该存在 + 岛不该存在"——比钉"解析只有一份"更靠上游，
  // 后者挡不住有人新写一整个平行实现。
  const block = hostDomainBlock('shipping-rate');
  const ops = stripComments(
    readFileSync(resolve(root, 'src', 'core', 'services', 'shipRateOps.ts'), 'utf-8'),
  );
  const svc = stripComments(
    readFileSync(resolve(root, 'src', 'core', 'services', 'importSheet.ts'), 'utf-8'),
  );

  it('host.ts 不得再有 shipping-rate 域（旧岛桥通路已下架）', () => {
    expect(block, 'shipping-rate 域已于 2026-10-15 整域删除，别再加回来').toBe('');
  });

  it('市场目录不得再有这两个已回收的岛（catalog 与 zip 都要清）', () => {
    // 对外发布的口子：留着条目就意味着用户仍能装到一个"功能已在宿主里"的旧岛，
    // 装上后按旧口径算钱 —— 比不发布更糟。
    const catalogPath = resolve(root, 'market-out', 'catalog.json');
    if (!existsSync(catalogPath)) return; // 市场仓不在本仓时跳过（发布机才产出）
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const ids = (catalog.plugins || []).map((p: { id: string }) => p.id);
    expect(ids).not.toContain('shipping-rate');
    expect(ids).not.toContain('shop-accounts');
  });

  it('单源仍在：解析只有 importSheet 一份实现', () => {
    expect(ops).toContain('export async function parseRateSheet');
    expect(ops, '服务层不复制解析').not.toMatch(/XLSX|xlsx/);
    expect(ops).toContain('importSheet.importRateSheet');
    expect(svc).toContain('pickRateSheet');
  });

  it('读表不得回落取第一个 sheet（报价单的第 1 张是「目录」）', () => {
    // 2026-09-24 真实故障：`want && includes(want) ? want : sheetNames[0]` 让"导入运价表"
    // 必然失败 —— 运营商报价单是 **21 张 sheet 拼一本**，第 1 张是「目录」，目标表在第 10 张；
    // 更糟的是它把原因误报成「该 sheet 不是报价单结构」，用户以为数据有问题。
    // 正确做法是逐张体检后按名称提示/国家数自动挑（pickRateSheet，见 tests/shipRate.spec.ts §⑤）。
    expect(ops).not.toMatch(/sheetNames\s*\[\s*0\s*\]/);
    expect(svc, '挑表必须用 pickRateSheet（不能回落取第一张）').toContain('pickRateSheet');
    expect(svc).not.toMatch(/sheetNames\s*\[\s*0\s*\]/);
  });

  it('导入走"名称提示"而不是"显式点名"（换版后 sheet 改名不该让导入硬失败）', () => {
    // 显式点名是"用户在下拉里选了哪张"，宿主会严格按它解析、不存在就报错。
    // 首次导入若沿用点名语义，用户拿到一份改过 sheet 名的新报价单时就会直接失败；
    // 传提示则能自动落到可用的表上。判据落在 shipRateOps：sheetName 与 prefer 是**两个语义**，
    // 都传下去（由 importSheet 决定谁生效），不许在服务层就把 prefer 改判成 sheetName。
    expect(ops).toMatch(/sheetName:\s*ecStr\(opts\.sheetName/);
    expect(ops).toMatch(/prefer:\s*ecStr\(opts\.prefer/);
  });

  it('计价口径单源：服务层不得出现费率算式，页面只收参数', () => {
    // 判据刻意只钉"对费率做四则运算"——不钉 Math.round/Math.ceil，
    // 因为取整展示是合法用途；一刀切会命中函数定义而非真正的算式。
    for (const field of ['ratePerKg', 'registerFee', 'firstFee', 'stepFee']) {
      expect(new RegExp(`\\b${field}\\s*[-+*/]`).test(ops)).toBe(false);
    }
    expect(ops, '计价确实走 quoteAll 单源').toContain('quoteAll');
  });
});

// ---------------------------------------------------------------------------
// ~~product-library 岛的能力对齐守卫~~ **已删（2026-10-01）**：该岛整组下架、功能收回内建
// 「货与成本」，`DB_OPS` 里它的五个能力域（product / product-admin / product-image /
// product-supplier / shop-products，共 32 op）随之删除 —— 反向守卫的两侧（岛声明 ↔ 宿主 op）
// 已不复存在，留着只会读一个空目录。
// 同样的契约现在由 `scripts/goods-ui-smoke.mjs` 在**内建页**上守着（38 条断言：一次性批量映射 /
// 不跨店铺串数据 / 未解析店铺不可点 / 标失效按行 id / 部分 patch 不发空字段 / 供应商改名不改名 …）。
// 将来再开岛时，按 excel-copy 的形态写回来即可。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 宿主 db 能力域的 op 预算（ADR-002 N5：新增域必须一次性给出 owner + 访问模式 + op 上限 ≤10）
// ---------------------------------------------------------------------------
//
// 为什么要有这条守卫：N5 是**约束新增域的设计动作**，写成文档没人拦得住 —— 2026-09-27 实测
// `product` 域从 6 涨到 8，而计划里还要再加 4 个只读 op（= 12 > 10）才被人工发现。
// 域内 op 越堆越多，会连带把"声明本域即拿到该域全部 op"的授权面一起放大（C4 要防的正是这个）。
//
// 两类豁免：
//   · 存量域（N6「存量域不为改名单独发版」）在冻结日已超 10，登记**当前数量**入表，**只允许变少**；
//   · 新增域一律 ≤10，不得进豁免表 —— 豁免表里出现预算内的域就说明它在被滥用（有断言钉住）。
describe('宿主 db 能力域的 op 预算（ADR-002 N5）', { timeout: 20000 }, () => {
  /**
   * 冻结日（2026-09-27）已超预算的存量域 → 当时实测数量。
   * **只允许变少，加 op 必须先拆子域**（这两个都是历史遗留的"万能域"，也是 ADR-002 N4 里
   * 点名要拆的：purchase 可再拆、shop-accounts → shop-set + company。
   * 原先第三个 `order-insight`(37) 已随该岛 2026-10-05 整体下架**整域删除**，从表里移出 ——
   * 它走后剩余域的最大值是 `purchase` 24，所以本组仍必须豁免，否则会立刻红）。
   */
  const GRANDFATHERED: Record<string, number> = {
    'shop-accounts': 21,
    purchase: 24,
  };
  const BUDGET = 10;

  it('DB_OPS 能解析出来（否则本组整段空转）', () => {
    const domains = hostDomains();
    expect(domains.length).toBeGreaterThan(0);
    // 这两个必须**同时**在：一个是**岛域**（多 op），一个是**主数据域**（少 op）。
    // 若哪天读成了别的段落，这里先红，不至于让本组静默空转。
    // 锚点换过一次：原为 `product` / `shop`（`product` 随产品库岛下架删除，2026-10-01 →
    // 改钉 `order-insight`）→ 本次 `order-insight` 也随岛下架删除（2026-10-05）→ 改钉 `shop-accounts`。
    expect(domains).toContain('shop-accounts');
    expect(domains).toContain('shop');
  });

  it.each(hostDomains())('%s 域：op 数在预算内或不超过冻结基线', (domain) => {
    const ops = hostDomainOps(domain);
    // 域被解析出来却一个 op 都没有 = 解析写法没覆盖，属空转，必须变红（历史坑：域键写法）
    expect(ops.length).toBeGreaterThan(0);
    const baseline = GRANDFATHERED[domain];
    if (baseline === undefined) {
      expect(
        ops.length,
        `${domain} 域有 ${ops.length} 个 op，超过 N5 的 ${BUDGET} 上限 —— 请按 ADR-002 C4 拆只读子域，而不是继续加`,
      ).toBeLessThanOrEqual(BUDGET);
    } else {
      expect(
        ops.length,
        `${domain} 是豁免的存量超额域（基线 ${baseline}），只允许变少`,
      ).toBeLessThanOrEqual(baseline);
    }
  });

  it('豁免表只装真超额的域：预算内的域不得登记豁免（防止豁免滥化）', () => {
    for (const [domain, baseline] of Object.entries(GRANDFATHERED)) {
      expect(hostDomains(), `豁免表里的 ${domain} 在 DB_OPS 里已不存在`).toContain(domain);
      expect(
        baseline,
        `${domain} 现已降到预算内（基线却记着 ${baseline}），请从豁免表里删掉它`,
      ).toBeGreaterThan(BUDGET);
    }
  });
});
