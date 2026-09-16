// src/core/plugin/managerDiscover.ts
// pluginManager 的「发现」职责（R3-3 拆分产物）：内建注册表发现 + 外置目录扫描登记 + UI 岛登记。
// 全部函数自 managerContext 原样搬移，行为零改动。

import {
  enabledModuleMetas,
  pluginPackageInfos,
} from '@/registry.generated';
import type { ModuleMeta } from '@/core/types';
import { type ExternalPluginDescriptor, discoverExternalPlugins } from './externalLoader';
import { createGatedHostApi } from './gatedHost';
import { createHostApi } from './host';
import type { PluginManifest } from './types';
import type { ManagerContext, PluginRecord } from './managerContext';

/** 内建插件统一 manifest 版本（随宿主分发，无独立版本演进） */
const BUILTIN_VERSION = '1.0.0';
const HOST_ENGINE_VERSION = '1.0.0';

/** 随宿主分发视图插件包的元数据（registry pluginPackageInfos：version/description/author） */
interface BuiltinPkgInfo {
  version?: string;
  description?: string;
  author?: string;
}

/** 由模块 meta 生成本阶段 manifest（内建静态贡献：视图）；扩展插件包附带 manifest.json 元数据 */
function createBuiltinManifest(meta: ModuleMeta, pkg?: BuiltinPkgInfo): PluginManifest {
  return {
    name: meta.id,
    displayName: meta.name,
    version: pkg?.version || BUILTIN_VERSION,
    engines: { sellerkit: HOST_ENGINE_VERSION },
    activationEvents: ['onStartup'],
    ...(pkg?.description ? { description: pkg.description } : {}),
    ...(pkg?.author ? { author: pkg.author } : {}),
    contributes: {
      views: [
        {
          id: 'main',
          title: meta.name,
          icon: meta.icon,
          order: meta.order,
          navHidden: meta.navHidden,
          container: 'host',
        },
      ],
    },
  };
}

export function createDiscoverOps(ctx: ManagerContext): {
  discover: () => void;
  discoverExternal: () => Promise<{ root: string; total: number; errors: Array<{ id: string; error: string }>; uiCount: number }>;
} {
  /** discover：从构建期注册表发现内建插件并注册静态视图贡献（随宿主分发视图插件经 extensions 根收录） */
  function discover(): void {
    for (const meta of enabledModuleMetas) {
      if (ctx.records.has(meta.id)) continue;
      const record: PluginRecord = {
        id: meta.id,
        manifest: createBuiltinManifest(meta, pluginPackageInfos[meta.id]),
        state: 'installed',
        source: 'builtin',
        kind: pluginPackageInfos[meta.id] ? 'extension' : 'module',
        trustLevel: 0,
        def: null,
        sandbox: null,
        disposers: [],
        ctx: null,
        ctxAbort: null,
      };
      ctx.records.set(meta.id, record);
      ctx.registerStaticView(record);
      ctx.setState(record, 'loaded');
    }
  }

  /** 登记一个校验通过的外置插件（manifest 来自文件，与内建记录字段对齐） */
  function registerExternal(p: ExternalPluginDescriptor): void {
    // UI 形态包（kind: ui）不经 L2 Worker 注册：入口为静态站点而非 ESM，Worker import 必失败。
    // §15 iframe 运行时岛登记为 P1 范围，discoverExternalPlugins 已前置过滤，此处为兜底不变式。
    if (p.manifest.kind === 'ui') return;
    if (ctx.records.has(p.id)) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin] 外置插件 "${p.id}" 与既有插件冲突，已跳过（内建不可被覆盖）`);
      return;
    }
    const record: PluginRecord = {
      id: p.id,
      manifest: p.manifest,
      state: 'installed',
      source: 'external',
      trustLevel: 2,
      def: null,
      sandbox: null,
      externalEntry: p.entry,
      disposers: [],
      ctx: null,
      ctxAbort: null,
    };
    ctx.records.set(p.id, record);
    ctx.setState(record, 'loaded'); // 发现完成（无静态视图贡献；命令在激活时注册）
  }

  /** 登记一个 UI 形态包（discoverExternal 消费 discoverExternalPlugins 的 ui[]）。
   *  新增时合成 loaded/installed 通知 → 宿主刷新侧栏（市场安装 UI 包后入口即时可见）；
   *  同 id 版本变更（市场更新落盘）→ 重建 manifest/权限门面并再次广播；同版本幂等跳过。 */
  function registerUiIsland(p: ExternalPluginDescriptor): void {
    if (ctx.records.has(p.id)) return;
    if (p.manifest.kind !== 'ui') return;
    const existing = ctx.uiIslands.get(p.id);
    if (existing && existing.manifest.version === p.manifest.version) return;
    ctx.uiIslands.set(p.id, {
      manifest: p.manifest,
      hostApi: createGatedHostApi(createHostApi(), p.manifest, ctx.gate, p.id),
    });
    ctx.notifyHostState(p.id, 'loaded', 'installed');
  }

  /** 扫描 <userData>/plugins 并登记（坏 manifest 不中断；返回错误清单供宿主提示；UI 形态包进独立轨道） */
  async function discoverExternal(): Promise<{
    root: string;
    total: number;
    errors: Array<{ id: string; error: string }>;
    uiCount: number;
  }> {
    const res = await discoverExternalPlugins();
    for (const p of res.plugins) registerExternal(p);
    for (const u of res.ui) registerUiIsland(u);
    return { root: res.root, total: res.plugins.length, uiCount: res.ui.length, errors: res.errors };
  }

  return { discover, discoverExternal };
}
