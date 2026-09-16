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

export declare const MODULE_ROOTS: ReadonlyArray<ModuleRootDef>;

/** 模块源码目录（相对 repo 根） */
export declare function moduleSrcDir(rootDef: ModuleRootDef, id: string): string;

/** meta.ts 绝对路径 */
export declare function metaPath(rootAbs: string, rootDef: ModuleRootDef, id: string): string;

/** 探测模块 id 落在哪个根；未找到返回 null */
export declare function resolveModuleKind(rootAbs: string, id: string): ModuleRootKind | null;

/** 按 kind 取根定义 */
export declare function rootDefByKind(kind: ModuleRootKind): ModuleRootDef;

/** 生成 registry 内的 import 路径 */
export declare function entryPath(kind: ModuleRootKind, id: string, file: string): string;

/** 从 meta.ts 源码提取展示名，失败回退 fallback */
export declare function readDisplayName(absMetaPath: string, fallback: string): string;

/** 枚举全部可打包模块（双根扫描） */
export declare function enumerateModules(rootAbs: string): {
  modules: EnumeratedModule[];
  skipped: SkippedDir[];
};
