// UI 岛设置贡献 → 宿主设置中心分类聚合 —— 钉住「分类 id / 名称 / 排序 / 停用过滤」口径。
//
// 背景（2026-09-18）：设置承载机制做成通用能力——岛在 manifest.settings 声明设置页入口，
// 宿主 SettingsModal 即出现 `<pluginId>:settings` 分类（内容为 iframe 岛）。
// 本测试用最小 fake ctx 直接跑 createSettingsOps，避免起整个插件管理器。
import { describe, it, expect } from 'vitest';
import { createSettingsOps } from '@/core/plugin/managerSettings';
import type { ManagerContext } from '@/core/plugin/managerContext';
import type { PluginManifest } from '@/core/plugin/types';

function islandManifest(id: string, settings?: PluginManifest['settings']): PluginManifest {
  return {
    name: id,
    displayName: `${id}（UI 岛）`,
    version: '1.0.0',
    engines: { sellerkit: '>=1.0.0' },
    activationEvents: [],
    kind: 'ui',
    entry: './dist/index.html',
    ...(settings ? { settings } : {}),
  };
}

function fakeCtx(
  islands: Array<[string, PluginManifest]>,
  disabled: string[] = [],
): ManagerContext {
  return {
    uiIslands: new Map(islands.map(([id, manifest]) => [id, { manifest, hostApi: {} }])),
    disabled: new Set(disabled),
  } as unknown as ManagerContext;
}

describe('UI 岛设置分类聚合（createSettingsOps.getIslandSettingCategories）', () => {
  it('声明了 settings.entry 的岛贡献分类，id 为 <pluginId>:settings', () => {
    const ctx = fakeCtx([
      ['shop-accounts', islandManifest('shop-accounts', { entry: './dist/settings.html' })],
    ]);
    const cats = createSettingsOps(ctx).getIslandSettingCategories();
    expect(cats).toEqual([
      {
        categoryId: 'shop-accounts:settings',
        categoryName: 'shop-accounts（UI 岛）',
        icon: 'box',
        order: 100,
        pluginId: 'shop-accounts',
        entry: './dist/settings.html',
      },
    ]);
  });

  it('展示字段按声明覆盖；未声明 settings 的岛不贡献', () => {
    const ctx = fakeCtx([
      [
        'shop-accounts',
        islandManifest('shop-accounts', {
          entry: './dist/settings.html',
          displayName: '账号管家',
          icon: 'key',
          order: 50,
        }),
      ],
      ['excel-copy', islandManifest('excel-copy')],
    ]);
    const cats = createSettingsOps(ctx).getIslandSettingCategories();
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ categoryName: '账号管家', icon: 'key', order: 50 });
  });

  it('已停用的岛不贡献；多岛按 order 升序', () => {
    const ctx = fakeCtx(
      [
        ['a-island', islandManifest('a-island', { entry: './dist/settings.html', order: 200 })],
        ['b-island', islandManifest('b-island', { entry: './dist/settings.html', order: 10 })],
        ['c-island', islandManifest('c-island', { entry: './dist/settings.html' })],
      ],
      ['c-island'],
    );
    const ids = createSettingsOps(ctx)
      .getIslandSettingCategories()
      .map((c) => c.categoryId);
    expect(ids).toEqual(['b-island:settings', 'a-island:settings']);
  });
});
