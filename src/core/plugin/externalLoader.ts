// src/core/plugin/externalLoader.ts
// 外置插件发现器（渲染层，Phase 3；Phase 4 起"入口求值"已迁移至 Worker 沙箱 sandbox.ts）。
// 职责：
//  1. discover：经 IPC 扫描 <userData>/plugins，对每个 manifest.json 做严格 schema 校验（externalManifest.ts），
//     产出可直接注册进 PluginManager 的 ExternalPluginDescriptor；
//  2. 入口源码的读取/求值不再在本文件进行：sandbox.ts 经 pluginsReadEntry 读码后注入 Worker，
//     与宿主解耦 realm（插件不可再直达 window.electronAPI/DOM）。
// 执行模型（§5 加载时序）：
//  - 外置插件目录只有 命令/设置 贡献（无 Vue 组件），因此不需要视图懒加载链路；
//  - 入口 JS 为"单文件自包含 ESM"（无外部 import），HostApi/SDK 类型仅为编译期视图，运行时以 ctx 注入。
// 约束：只依赖 core/services/ipc（渲染层 IPC 收敛层）与 plugin 内核类型；不引业务模块。

import { pluginsScan } from '@/core/services/ipc';
import { validateExternalManifest } from './externalManifest';
import type { PluginManifest } from './types';

/** 扫描条目 → 校验通过的外置插件描述 */
export interface ExternalPluginDescriptor {
  id: string;
  /** 入口相对路径（已归一化 ./index.js） */
  entry: string;
  manifest: PluginManifest;
}

export interface ExternalDiscoverResult {
  /** 校验通过、可被管理器接纳的插件 */
  plugins: ExternalPluginDescriptor[];
  /** 插件根目录（供"打开插件目录"等展示） */
  root: string;
  /** 目录/manifest 层面的失败（不中断其他插件） */
  errors: Array<{ id: string; error: string }>;
}

/** 扫描并校验插件目录（坏 manifest 只记录 error，不抛错） */
export async function discoverExternalPlugins(): Promise<ExternalDiscoverResult> {
  const result: ExternalDiscoverResult = { plugins: [], root: '', errors: [] };
  const r = await pluginsScan();
  if (!r.success || !r.data) {
    result.errors.push({ id: '*', error: r.error ?? '扫描插件目录失败（IPC 不可用）' });
    return result;
  }
  result.root = r.data.root;
  for (const item of r.data.plugins) {
    if (item.error) {
      result.errors.push({ id: item.id, error: item.error });
      continue;
    }
    const v = validateExternalManifest(item.manifest);
    if (!v.ok) {
      result.errors.push({ id: item.id, error: v.error });
      continue;
    }
    // 目录名与 manifest.name 一致性由主进程保证（plugins-handlers）；此处二次兜底
    if (item.id !== v.manifest.name) {
      result.errors.push({ id: item.id, error: `目录名(${item.id})与 manifest.name(${v.manifest.name})不一致` });
      continue;
    }
    result.plugins.push({ id: v.manifest.name, entry: v.manifest.entry ?? './index.js', manifest: v.manifest });
  }
  return result;
}
