'use strict';
/**
 * 模块根解析 —— 单一事实源（Single Source of Truth）
 *
 * 背景：Phase 5「随宿主分发视图插件」之后，业务模块源码存在两个物理根：
 *   1) src/modules/<id>/      —— 常规内建业务模块
 *   2) extensions/<id>/src/   —— 随宿主分发的视图插件包（kind=view，构建期随包编译）
 *
 * 判定规则（唯一权威）：**目录下存在 meta.ts 入口**才算一个可打包模块。
 *   - src/modules/<id>/meta.ts
 *   - extensions/<id>/src/meta.ts
 * 没有 meta.ts 的目录（脚手架 _template / 示例 sk-hello / 纯 UI 岛源码）不参与打包裁剪。
 *
 * ⚠ 例外：**已下记为市场 UI 岛的 id 不是可打包模块**（见 isUndocked）。
 * 下记只把 id 从 modules.config.json 摘掉、并让源码留档在 extensions/<id>/，
 * 留档目录里仍然躺着 meta.ts —— 于是「有 meta.ts 即模块」的规则会把已下记的 id
 * 重新算成候选。这正是 AGENTS 红线 23 要防的场景，且后果是静默的：
 * 宿主 registry 先占住 id → registerUiIsland() 见 records.has(id) 直接 return
 * → 从市场安装的岛**永远没有侧栏入口**。故此处按 id 硬性排除。
 *
 * 本文件被两处消费，避免规则二次漂移：
 *   - vite.config.ts        （构建期生成 registry.generated.ts）
 *   - scripts/select-build.js（交互式打包选择器）
 * 修改根定义或探测规则时，只改这里。
 *
 * 注意：本文件是 CommonJS（.js 在无 "type":"module" 的包内即 CJS），vite.config.ts
 *       通过相对 import 引入，由 Vite 的 esbuild 配置加载器做 CJS→ESM 互操作；
 *       类型声明见同目录 module-roots.d.cts。
 */

const fs = require('fs');
const path = require('path');

/** 市场分发的 UI 岛根目录（kind=ui，iframe 承载，不参与宿主打包） */
const UI_PLUGINS_DIR = 'ui-plugins';

/**
 * 模块根定义。顺序即探测优先级（先 modules 后 extensions）。
 * @type {ReadonlyArray<{kind:'modules'|'extensions', dir:string, metaRel:string, srcRel:string, entryPrefix:string, label:string}>}
 */
const MODULE_ROOTS = Object.freeze([
  Object.freeze({
    kind: 'modules',
    dir: 'src/modules',
    metaRel: 'meta.ts',
    srcRel: '',
    entryPrefix: '@/modules/',
    label: '内建',
  }),
  Object.freeze({
    kind: 'extensions',
    dir: 'extensions',
    metaRel: 'src/meta.ts',
    srcRel: 'src',
    entryPrefix: '../extensions/',
    label: '插件包',
  }),
]);

/** 模块源码目录（相对 repo 根） */
function moduleSrcDir(rootDef, id) {
  return rootDef.srcRel
    ? path.posix.join(rootDef.dir, id, rootDef.srcRel)
    : path.posix.join(rootDef.dir, id);
}

/** meta.ts 绝对路径 */
function metaPath(rootAbs, rootDef, id) {
  return path.join(rootAbs, rootDef.dir, id, rootDef.metaRel);
}

/**
 * 探测某个模块 id 落在哪个根。
 * @returns {'modules'|'extensions'|null} 未找到返回 null
 */
function resolveModuleKind(rootAbs, id) {
  for (const r of MODULE_ROOTS) {
    if (fs.existsSync(metaPath(rootAbs, r, id))) return r.kind;
  }
  return null;
}

/**
 * 该 id 是否已下记为市场 UI 岛（`ui-plugins/<id>` 存在）。
 *
 * 下记（undock）= 把 id 从 modules.config.json 摘掉，让市场岛注册同一个 id。
 * 源码会留档在 `extensions/<id>/`（仍含 meta.ts），但那只是档案，**不可再打包**：
 *   - 宿主 registry 收录它 → `managerDiscover.discover()` 先占 id
 *   - → `registerUiIsland()` 见 `records.has(id)` 静默 return
 *   - → 从市场装的岛永远没有侧栏入口（AGENTS 红线 23）
 * 附带损害：把该模块的整条依赖链（如 xlsx）重新打进包。
 *
 * @param {string} rootAbs repo 根绝对路径
 * @param {string} id 模块 id
 * @returns {boolean}
 */
function isUndocked(rootAbs, id) {
  try {
    return fs.existsSync(path.join(rootAbs, UI_PLUGINS_DIR, id));
  } catch {
    return false;
  }
}

/** 取根定义对象（按 kind） */
function rootDefByKind(kind) {
  const r = MODULE_ROOTS.find((x) => x.kind === kind);
  if (!r) throw new Error(`[module-roots] unknown kind: ${kind}`);
  return r;
}

/**
 * 生成 registry 内的 import 路径。
 *   src/modules/quick-note  -> '@/modules/quick-note/<file>'
 *   extensions/excel-copy   -> '../extensions/excel-copy/src/<file>'
 */
function entryPath(kind, id, file) {
  const r = rootDefByKind(kind);
  return `${r.entryPrefix}${id}/${r.srcRel ? `${r.srcRel}/` : ''}${file}`;
}

/** 从 meta.ts 源码提取展示名（`name: '...'`），失败则回退 id */
function readDisplayName(absMetaPath, fallback) {
  try {
    const src = fs.readFileSync(absMetaPath, 'utf-8');
    const m = src.match(/name:\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  } catch {
    /* 读取失败用 id 兜底 */
  }
  return fallback;
}

/** 列出某根下所有目录名（按字典序），目录不存在返回 [] */
function listDirs(absDir) {
  try {
    return fs
      .readdirSync(absDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 枚举全部可打包模块（双根扫描）。
 *
 * 三条互斥的去向：
 *   - modules  ：有 meta.ts 且**未被下记** → 可打包
 *   - migrated ：有 meta.ts 但 id 已被市场 UI 岛接管 → **绝不可打包**（红线 23）
 *   - skipped  ：缺 meta.ts 入口（脚手架/示例/纯 UI 岛源码）→ 本就不参与打包
 *
 * @param {string} rootAbs repo 根绝对路径
 * @returns {{modules: Array<{id:string,name:string,kind:string,label:string}>,
 *            migrated: Array<{id:string,name:string,kind:string,label:string}>,
 *            skipped: Array<{id:string,kind:string,label:string}>}}
 */
function enumerateModules(rootAbs) {
  const modules = [];
  const migrated = [];
  const skipped = [];

  for (const r of MODULE_ROOTS) {
    const baseDir = path.join(rootAbs, r.dir);
    for (const id of listDirs(baseDir)) {
      const absMeta = metaPath(rootAbs, r, id);
      if (!fs.existsSync(absMeta)) {
        skipped.push({ id, kind: r.kind, label: r.label });
        continue;
      }
      const entry = {
        id,
        name: readDisplayName(absMeta, id),
        kind: r.kind,
        label: r.label,
      };
      // 已下记的 id 交给市场岛，宿主不得再收录（见 isUndocked）
      (isUndocked(rootAbs, id) ? migrated : modules).push(entry);
    }
  }

  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  modules.sort(byId);
  migrated.sort(byId);
  return { modules, migrated, skipped };
}

module.exports = {
  MODULE_ROOTS,
  UI_PLUGINS_DIR,
  moduleSrcDir,
  metaPath,
  resolveModuleKind,
  isUndocked,
  rootDefByKind,
  entryPath,
  readDisplayName,
  enumerateModules,
};
