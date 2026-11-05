/**
 * module-roots.cjs 的类型声明。
 * vite.config.ts（ESM/TS）以相对路径 import 该 CJS 模块，需要此声明供类型检查。
 * 实现与导出保持同步：任何导出变更都必须同时改这里。
 */

export type ModuleRootKind = 'modules' | 'extensions';

export interface ModuleRootDef {
  kind: ModuleRootKind;
  /** 相对 repo 根的模块根目录 */
  dir: string;
  /** 相对模块目录的 meta 入口路径 */
  metaRel: string;
  /** 相对模块目录的源码子目录（内建为空串） */
  srcRel: string;
  /** registry 内 import 前缀 */
  entryPrefix: string;
  /** 展示用中文标签 */
  label: string;
}

export interface EnumeratedModule {
  id: string;
  name: string;
  kind: ModuleRootKind;
  label: string;
}

export interface SkippedDir {
  id: string;
  kind: ModuleRootKind;
  label: string;
}

/** 已下记为市场 UI 岛的模块：源码留档在 extensions/ 下，但宿主不得再打包 */
export type MigratedModule = EnumeratedModule;

export declare const MODULE_ROOTS: ReadonlyArray<ModuleRootDef>;

/** 市场分发的 UI 岛根目录（kind=ui） */
export declare const UI_PLUGINS_DIR: 'ui-plugins';

/** 模块源码目录（相对 repo 根） */
export declare function moduleSrcDir(rootDef: ModuleRootDef, id: string): string;

/** meta.ts 绝对路径 */
export declare function metaPath(rootAbs: string, rootDef: ModuleRootDef, id: string): string;

/** 探测模块 id 落在哪个根；未找到返回 null */
export declare function resolveModuleKind(rootAbs: string, id: string): ModuleRootKind | null;

/**
 * 该 id 是否已下记为市场 UI 岛（`ui-plugins/<id>` 存在）。
 * 返回 true 时宿主**不得**把该 id 打进 registry（AGENTS 红线 23）。
 */
export declare function isUndocked(rootAbs: string, id: string): boolean;

/** 按 kind 取根定义 */
export declare function rootDefByKind(kind: ModuleRootKind): ModuleRootDef;

/** 生成 registry 内的 import 路径 */
export declare function entryPath(kind: ModuleRootKind, id: string, file: string): string;

/** 从 meta.ts 源码提取展示名，失败回退 fallback */
export declare function readDisplayName(absMetaPath: string, fallback: string): string;

/** 枚举模块（双根扫描），按 id 去重后分入三条互斥去向 */
export declare function enumerateModules(rootAbs: string): {
  /** 可打包：有 meta.ts 且未被下记 */
  modules: EnumeratedModule[];
  /** 已下记为市场 UI 岛：有 meta.ts 但绝不可打包 */
  migrated: MigratedModule[];
  /** 缺 meta.ts 入口：本就不参与打包 */
  skipped: SkippedDir[];
};
