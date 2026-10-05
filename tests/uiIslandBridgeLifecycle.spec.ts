// UI 岛「接入接线」守卫 —— 钉住三类**静默失效**（都不报错、都表现为「点导航一片空白」）。
//
// 背景（2026-09-24 现场复现，Node+CDP 驱动真实 Electron 逐岛点击取证）：
//   · 症状：重启后**本会话第一个岛能用，之后每个岛都是空白**（工具条还显示「桥已连接」）；
//   · 主因：Vue 复用同位置同类型组件 + AppShell 未给 UiIslandView 加 `key`
//     → 切岛只换 prop、组件实例与「桥」不重建 → 旧桥的 expectedOrigin/token 属于上一个岛
//     → 新岛的 hello 被判串台丢弃、旧桥补发的 boot 被 postMessage **静默丢弃**（targetOrigin 不匹配
//     不抛错、不打印）→ 新岛永久停在「等待桥握手」→ 首屏门控在 boot 之后的岛即一片空白。
//   · 次因（打包版专属、更彻底）：plugin-ui-runtime.js 既没进 dist/（tsc 不搬运未 import 的 .js）
//     也没进 electron-builder files → 打包版 asar 内找不到桥运行时 → 不注入 sk-plugin:// 桥
//     → **所有**岛的 window.__sk 缺失、首屏空白。dev 模式读项目源码，故只在打包版暴露。
//
// 这些约束都无法用行为断言覆盖（vitest environment=node，无 DOM/无 Electron），
// 故按本仓既有守卫风格（uiIslandThemeTokens.spec.ts / pluginTriage.spec.ts）做静态断言：
// 谁改坏了这一层，谁在这里失败，而不是又变成一次"用户报障 → 手工冒烟才发现"。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UI_MSG } from '@/core/plugin/uiBridgeHost';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const exists = (rel: string) => existsSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)));

const appShell = read('src/core/AppShell.vue');
const islandView = read('src/core/components/UiIslandView.vue');
const runtime = read('electron/plugin-ui-runtime.js');
const builderYml = read('electron-builder.yml');
const tsconfigElectron = read('tsconfig.electron.json');

describe('UI 岛切岛生命周期：桥必须随「当前岛」重建', () => {
  it('AppShell 渲染 UiIslandView 时必须绑定 key（否则换岛不重建组件与桥）', () => {
    const block = appShell.slice(
      appShell.indexOf('<UiIslandView'),
      appShell.indexOf('/>', appShell.indexOf('<UiIslandView'))
    );
    expect(
      block,
      'AppShell.vue 的 <UiIslandView> 缺少 :key="activeIslandId"。\n' +
        '没有 key 时 Vue 复用组件实例，切岛只换 prop：旧桥（旧岛的 expectedOrigin/token）继续服务，\n' +
        '新岛的 hello 被判串台、旧桥的 boot 被 postMessage 静默丢弃 → 新岛永久「等待桥握手」→ 空白页。'
    ).toMatch(/:key="activeIslandId"/);
  });

  it('UiIslandView 的 attach 必须按 pluginId 判定是否需要重建桥（不能只看 bridge 是否存在）', () => {
    expect(
      islandView,
      'UiIslandView.vue 的 attach() 必须记录并比较 bridgePluginId（组件被复用到另一个岛时先 dispose 再重建）。\n' +
        '原实现 `if (bridge.value) return` 只对「一个组件实例只服务一个岛」成立，是本次空白页故障的落点。'
    ).toContain('bridgePluginId');
    expect(
      islandView,
      'attach() 里不应再出现「只判断 bridge.value 就返回」的写法（会再次引入切岛静默失效）。'
    ).not.toMatch(/if \(bridge\.value( \|\| [^)]*)?\) return;/);
  });

  it('切岛/卸载时必须 dispose 桥（会话不跨岛、不跨组件实例）', () => {
    const disposeCount = (islandView.match(/\.dispose\(\)/g) ?? []).length;
    expect(
      disposeCount,
      'UiIslandView 少于 2 处 dispose（切岛重建 + onBeforeUnmount 卸载）'
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('UI 岛可以被「恢复上次所在模块」命中（启动时序）', () => {
  // ⚠️ 只在 onMounted 体内比对**调用点**。若直接对整个文件 indexOf('pm.discoverExternal()')，
  //    命中的是函数**定义**那一行（文本位置恒在恢复逻辑之前）——那样的断言把扫描挪到恢复之后仍然全绿，
  //    属于「看起来测了、其实什么都没测」。此处按调用语句在 onMounted 内的先后判定（已反向验证会变红）。
  const mountBody = appShell.slice(appShell.indexOf('onMounted(async () =>'));

  it('发现外置插件/岛必须在恢复上次模块**之前**、且必须 await', () => {
    const scanCallAt = mountBody.indexOf('scanExternalPlugins();');
    const restoreAt = mountBody.indexOf('saved?.lastActiveModuleId');
    expect(scanCallAt, 'onMounted 里不再调用 scanExternalPlugins()').toBeGreaterThan(-1);
    expect(restoreAt, 'onMounted 里不再恢复 lastActiveModuleId').toBeGreaterThan(-1);
    expect(
      scanCallAt,
      '启动顺序反了：恢复上次所在模块时 UI 岛尚未登记（discoverExternal 晚于 pm.has 判定）→ ' +
        '`pm.has(id)` 判假 → 静默回落首个非岛模块，表现为「重启后不回到上次的岛」。\n' +
        '修：把扫描提到恢复之前。'
    ).toBeLessThan(restoreAt);
    expect(
      mountBody,
      '扫描没有被 await：恢复逻辑会在扫描完成前就跑，时序问题照样存在（且更难查）。'
    ).toContain('await scanExternalPlugins()');
  });

  it('不得回退成「扫描与启动合并」的单函数（会再次把扫描挤到恢复之后）', () => {
    expect(
      appShell,
      'AppShell 里又出现了 discoverAndStartExternalPlugins()（扫描+启动合一）。\n' +
        '它的语义是「activate 之后才扫」，正好会让岛赶不上恢复窗口；请保持 scan / start 两段分离。'
    ).not.toContain('discoverAndStartExternalPlugins');
  });
});

describe('UI 岛桥运行时：分发包里必须能找到 plugin-ui-runtime.js', () => {
  it('源文件存在且是「经典脚本」（无 import/export，否则注入到 UI 包 HTML 会解析失败）', () => {
    expect(exists('electron/plugin-ui-runtime.js'), '桥运行时源文件缺失').toBe(true);
    expect(runtime, '运行时不得出现 ESM 语法（它是 <script src> 注入的经典脚本）').not.toMatch(
      /^\s*(import|export)\s/m
    );
  });

  it('electron-builder files 必须收录该运行时（否则打包版不注入桥 → 所有岛空白）', () => {
    expect(
      builderYml,
      'electron-builder.yml 的 files 未收录 electron/plugin-ui-runtime.js。\n' +
        'tsc 不会把未 import 的 .js 搬进 dist/，asar 内两处候选都 miss → loadRuntimeSource() 返回 null\n' +
        '→ 不注入桥 → 打包版所有 UI 岛的 window.__sk 缺失、点导航空白。'
    ).toContain('electron/plugin-ui-runtime.js');
  });

  it('不得把该 .js 交给 tsc 编译（会被全文重写/压注释，改变逐字节下发给浏览器的内容）', () => {
    expect(
      tsconfigElectron,
      'tsconfig.electron.json 的 include 不应包含 electron/**/*.js：\n' +
        'allowJs 会把 plugin-ui-runtime.js 当输入文件重写输出（实测 12KB→14KB、注释全丢）。\n' +
        '分发路径是 electron-builder files 中显式收录原始文件。'
    ).not.toMatch(/"electron\/\*\*\/\*\.js"/);
  });

  it('loadRuntimeSource 的两个候选路径与「分发形态」对得上（dev 源码 / asar 内同路径）', () => {
    const protocol = read('electron/plugin-ui-protocol.ts');
    expect(protocol).toContain("path.join(app.getAppPath(), 'electron', 'plugin-ui-runtime.js')");
    expect(protocol).toContain("path.join(__dirname, 'plugin-ui-runtime.js')");
  });
});

describe('UI 岛双端协议（AGENTS 红线 20）：宿主 UI_MSG 与运行时 TYPE 必须一一对应', () => {
  /** 从运行时源码里取出 TYPE = { ... } 的键值对（运行时用缩写键，**值**才是协议字面量） */
  function runtimeType(): Record<string, string> {
    const block = runtime.slice(
      runtime.indexOf('var TYPE = {'),
      runtime.indexOf('};', runtime.indexOf('var TYPE = {'))
    );
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/(\w+):\s*'([^']+)'/g)) out[m[1]] = m[2];
    return out;
  }

  it('两端的消息字面量集合完全一致（键可以是缩写，值必须是同一份协议）', () => {
    const rt = runtimeType();
    const host = { ...UI_MSG } as Record<string, string>;
    const hostValues = Object.entries(host)
      .filter(([k]) => k !== 'mark') // mark 在运行时是独立的 var MARK
      .map(([, v]) => v)
      .sort();
    expect(
      [...new Set(Object.values(rt))].sort(),
      '运行时 TYPE 与宿主 UI_MSG 的消息字面量不一致'
    ).toEqual(hostValues);
  });

  it('消息标记字段名两端一致（__sk）', () => {
    const m = runtime.match(/var MARK = '([^']+)'/);
    expect(m?.[1], '运行时 MARK 与宿主 UI_MSG.mark 不一致').toBe(UI_MSG.mark);
  });
});
