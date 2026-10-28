import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import {
  resolveModuleKind,
  isUndocked,
  entryPath as sharedEntryPath,
} from './scripts/lib/module-roots.cjs';

const root = process.cwd();

// 模块源码双根解析：
//   - src/modules/<id>/      —— 常规内建业务模块（保留 modules 机制，当前唯一实例是 quick-note）
//   - extensions/<id>/src/   —— 随宿主分发的视图插件包（kind=view，构建期随包编译）
// 当前分布与实例清单见 docs/baseline/PROJECT_BASELINE.md §3/§4，此处不重复（易滞后）。
// 另注：excel-copy / order-insight 已下记为市场 UI 岛，其 extensions/ 目录仅为源码留档，
//       不会再走这条路径（由下方 isUndocked 守卫硬拦）。
// 规则唯一权威在 scripts/lib/module-roots.cjs（与 scripts/select-build.js 共用），避免二次漂移。
function resolveModuleRoot(id: string): 'modules' | 'extensions' | null {
  return resolveModuleKind(root, id);
}

// 读取 modules.config.json：纯字面量 JSON，直接解析即可。
// 历史上该文件是 modules.config.ts，需用 esbuild 的 transformSync 转译后求值；
// 而 esbuild 只是 vite 的传递依赖、并未在 package.json 声明——Vite 8 改用 Rolldown/Oxc
// 后该依赖会消失，构建配置随之失效。改为 JSON 后既消除隐式依赖，也天然强制
// AGENTS.md §1.3 要求的「纯字面量、禁止复杂逻辑」。
const buildConfig: {
  profile?: string;
  profiles?: Record<string, string[]>;
  enabledModules?: string[];
} = JSON.parse(readFileSync(resolve(root, 'modules.config.json'), 'utf-8'));

// 解析本次构建要启用的模块（优先级从高到低）：
//   1) MODULE_IDS 环境变量（逗号分隔模块 id，交互式/自定义打包用，如 MODULE_IDS=quick-note）
//   2) MODULE_PROFILE 环境变量命中的预设（构建时灵活覆盖）
//   3) 文件中的 profile 字段命中的预设
//   4) enabledModules 兜底
//
// 注意用 `??` 而不是 `||`：`||` 会把「预设存在但为空数组」和「预设不存在」混为一谈，
// 于是 minimal: [] 会静默回落到 enabledModules —— 一个"纯外壳"预设根本表达不出来，
// 而且日志里还会显示成它自己的名字，排查时极易误判。
const profileName = process.env.MODULE_PROFILE || buildConfig.profile || 'standard';
const rawIds = (process.env.MODULE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const enabled: string[] = rawIds.length
  ? rawIds
  : buildConfig.profiles?.[profileName] ?? buildConfig.enabledModules ?? [];

console.log(`[vite] build profile="${profileName}" modules=[${enabled.join(', ')}]`);

// 根据启用清单生成 registry.generated.ts
// 关键点：生成文件只 import enabledModules 中的 meta 与 index，
// 因此未启用的业务模块不会出现在源码引用链中 → 不进入 bundle（构建期裁剪）
const varName = (id: string) => id.replace(/-/g, '');
const roots: Record<string, string> = {};
for (const id of enabled) {
  const r = resolveModuleRoot(id);
  if (!r) {
    console.error(`[vite] ⚠ module/plugin "${id}" not found in src/modules or extensions/<id>/src — skipped`);
    continue;
  }
  // 红线 23：已下记为市场 UI 岛的 id 不得再进 registry。
  // 收录它会让 managerDiscover 先占 id，registerUiIsland() 静默 return，
  // 于是从市场装的岛永远没有侧栏入口，且整条依赖链（如 xlsx）被重新打进包。
  // 这里必须**报错**而非静默跳过 —— 能走到这一行说明调用方（MODULE_IDS / 预设）本身写错了。
  if (isUndocked(root, id)) {
    console.error(
      `[vite] ⛔ "${id}" 已下记为市场 UI 岛（ui-plugins/${id} 存在），不可再打进宿主 registry — 已忽略。` +
        `请改用市场分发，或修正 MODULE_IDS / modules.config.json。`,
    );
    continue;
  }
  roots[id] = r;
}
const active = enabled.filter((id) => roots[id]);
/** 模块/插件包入口路径：extensions 根为 extensions/<id>/src/<file>，src/modules 根为 src/modules/<id>/<file> */
const entryPath = (id: string, file: string) =>
  sharedEntryPath(roots[id] as 'modules' | 'extensions', id, file);
const metaImports = active
  .map((id) => `import * as ${varName(id)} from '${entryPath(id, 'meta')}';`)
  .join('\n');
const metaArr = active.map((id) => `${varName(id)}.meta`).join(', ');
const loaders = active
  .map((id) => `  '${id}': () => import('${entryPath(id, 'index')}'),`)
  .join('\n');

// —— 随宿主分发视图插件包的元数据（读取 extensions/<id>/manifest.json；src/modules 内建无条目）——
// 供 PluginCenter/overview 展示版本、描述与作者。
const pkgLines = active
  .filter((id) => roots[id] === 'extensions')
  .map((id) => {
    try {
      const m = JSON.parse(readFileSync(resolve(root, `extensions/${id}/manifest.json`), 'utf-8'));
      const extra = [
        m.description ? `description: ${JSON.stringify(m.description)}` : '',
        m.author ? `author: ${JSON.stringify(m.author)}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      return `  '${id}': { version: ${JSON.stringify(m.version || '0.0.0')}${extra ? `, ${extra}` : ''} },`;
    } catch (e: any) {
      console.warn(`[vite] manifest parse failed for extensions/${id}/manifest.json`, e?.message);
      return '';
    }
  })
  .filter(Boolean);

// —— 设置面板入口（settings.ts 存在才生成 loader；SettingsModal 分类导航按此贡献驱动）——
// 三个来源，同一个队列：
//   · 插件包：`extensions/<id>/src/settings.ts`（随宿主分发的视图插件包）
//   · 内建模块：`src/modules/<id>/settings.ts`（2026-10-14 起 —— 岛回收为内建模块后，
//     原 `manifest.settings` 的 iframe 岛设置页改为宿主组件贡献，形状与上面完全一致）
//   · **宿主自有**：`src/core/settings/panels.ts`（如「识别」引擎与密钥 —— 它不属于任何业务模块，
//     但按 AGENTS §1.5 必须**走贡献**而不是硬编码进 SettingsModal；键 `core` 不是模块 id，故不可被停用）
const settingsEntryExists = (id: string): boolean =>
  roots[id] === 'extensions'
    ? existsSync(resolve(root, `extensions/${id}/src/settings.ts`))
    : existsSync(resolve(root, `src/modules/${id}/settings.ts`));
const settingsLoaderLines = active
  .filter((id) => settingsEntryExists(id))
  .map((id) => `  '${id}': () => import('${entryPath(id, 'settings')}'),`)
  .concat(
    existsSync(resolve(root, 'src/core/settings/panels.ts'))
      ? [`  'core': () => import('@/core/settings/panels'),`]
      : [],
  )
  .join('\n');

const generated = `// AUTO-GENERATED by vite.config.ts — do not edit.
${metaImports}
export const enabledModuleMetas = [${metaArr}];
export const moduleViewLoaders: Record<string, () => Promise<any>> = {
${loaders}};

// 随宿主分发视图插件包元数据（extensions/<id>/manifest.json；src/modules 内建无条目）
export const pluginPackageInfos: Record<string, { version: string; description?: string; author?: string }> = {
${pkgLines.length ? pkgLines.join('\n') : '  // (none)'}
};

// 设置面板入口（插件包 src/settings.ts + 宿主自有 src/core/settings/panels.ts；无贡献则空）
export const settingsPanelLoaders: Record<string, () => Promise<any>> = {
${settingsLoaderLines ? settingsLoaderLines : '  // (none)'}
};
`;

writeFileSync(resolve(root, 'src/registry.generated.ts'), generated);

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(root, 'src'),
    },
  },
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
