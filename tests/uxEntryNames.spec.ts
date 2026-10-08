// 悬空入口名守卫（2026-09-30，UX 审查 C4 的机器化）
//
// 判据：宿主**用户可见文案**里"让用户去某个入口"的引号名，必须是真实存在的入口，三选一：
//   ① 宿主内建模块名（`src/modules/*/meta.ts` 的 `name`）
//   ② 市场 UI 岛的 `displayName`（`ui-plugins/*/manifest.json`，去掉「（UI 岛）」后缀）
//   ③ 少数"是页面上的控件 / 设置区"而非入口的名字 → `ALLOWED_NON_ENTRY`（**逐条写理由**）
//
// 为什么需要它（历史反例）：空运价表时提示写着 `先去「运费测算」导入一次运价表` ——
// 全仓没有叫「运费测算」的功能（真实入口是「无忧物流运费」），用户照提示找不到东西。
// 这类错**只有人点那条路径才会发现**，所以钉在源码上（文案是常量，扫描是最省的守卫）。
//
// ⚠️ 扫描型守卫必须**自证非空转**：模式写错会"零命中 ⇔ 通过"长得一样，故末尾断言采样数 > 0。
// ⚠️ 扫描前必须**剥注释**（本仓注释里大量出现引号名，不剥会拿注释判文案）——
//    这里用与 `tests/pluginTriage.spec.ts` 同源的 `stripComments`（两处是刻意双份：守卫之间不互相 import，
//    免得一个坏掉连坐另一个；改动其一时先看另一处）。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 去代码注释（保留字符串字面量：文案就在里面） */
const stripComments = (s: string): string => {
  let out = '';
  let i = 0;
  let start = 0;
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
      i = end;
      start = i;
      continue;
    }
    i++;
  }
  out += s.slice(start);
  // `<!-- … -->` 是 **Vue 模板注释**：它不在 DOM 里、用户一个字都看不到，
  // 但它会命中"去/到「X」"这类模式（本守卫第一版就因此把一条模板注释误报成悬空入口名）。
  return out.replace(/<!--[\s\S]*?-->/g, '');
};

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(vue|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 宿主内建模块的显示名（meta.ts 的 `name:`，只取没有 navHidden 的那些——这里不区分，全都算合法名） */
function hostModuleNames(): string[] {
  const dir = join(ROOT, 'src', 'modules');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const meta = join(dir, e.name, 'meta.ts');
      if (!existsSync(meta)) return '';
      const m = /name:\s*'([^']+)'/.exec(readFileSync(meta, 'utf-8'));
      return m?.[1] ?? '';
    })
    .filter(Boolean);
}

/** 市场 UI 岛的显示名（manifest.json 的 displayName，去掉「（UI 岛）」后缀 —— 文案里通常只写主名） */
function islandNames(): string[] {
  const dir = join(ROOT, 'ui-plugins');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const mf = join(dir, e.name, 'manifest.json');
      if (!existsSync(mf)) return '';
      try {
        const displayName = String(JSON.parse(readFileSync(mf, 'utf-8')).displayName ?? '');
        return displayName.replace(/（UI 岛）\s*$/, '').trim();
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

/**
 * 「今天」页（发货台）的**页签名**（`src/modules/today/flowCtx.ts` 的 `SHIPPING_TAB_NAMES`）。
 *
 * 为什么单列一类：2026-10-05 把六步收进一页多页签之后，页签名成了**新的入口名** ——
 * 用户真的点得到它们，所以文案里写「去「归类核对」页签」与写「去「货与成本」」是同一件事，
 * 都得能对上真东西。**按真入口处理（进 `known`），不是按控件豁免（进 ALLOWED_NON_ENTRY）** ——
 * 豁免是给"页面上看得见的文字"用的，而这里是可以跳过去的去处。
 */
function shippingTabNames(): string[] {
  const p = join(ROOT, 'src', 'modules', 'today', 'flowCtx.ts');
  if (!existsSync(p)) return [];
  const m = /SHIPPING_TAB_NAMES\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(readFileSync(p, 'utf-8'));
  if (!m?.[1]) return [];
  return (m[1].match(/:\s*'([^']+)'/g) ?? []).map((x) => x.replace(/^:\s*'/, '').replace(/'$/, ''));
}

/**
 * 「不是入口」的合法引号名 —— **每一项都要写理由**，且在页面上是**可见的控件 / 设置区**：
 * 用户看到它时它就在眼前（按钮文字、列名、页签），不需要"去找"。
 */
const ALLOWED_NON_ENTRY: Record<string, string> = {
  '导入 Excel': '按钮文字（在「今天」页上就这么写），不是跳转目标',
  刷新: '按钮文字',
  生成待拣清单: '按钮文字',
  更多: '按钮文字（拣货页工具栏的展开开关）',
  缺: '明细表列名（"已在「缺」列标出"）',
  已安装插件: '设置 › 插件 下的页签名',
  插件市场: '设置 › 插件 下的页签名',
  '设置 → 插件': '设置页内的路径描述（两段都是可见的菜单名）',
  识别设置: '「订单归类」岛内的页签名（岛内页签名不在宿主里可枚举，故按控件处理）',
  // 「拿货对账」同上：它是「订单归类」岛 `views/stockin.js` 注册的**一级页签名**
  // （`export default { id: 'stockin', title: '拿货对账', order: 60 }`，island 1.5.0）。
  // 宿主只能跳到岛、跳不进岛的某个页（`switchModule` 的 action/payload 目前无消费方），
  // 故文案里点名页签、按钮只承诺"打开岛"。岛改页签名时要同步这里（同「识别设置」的暴露面）。
  拿货对账: '「订单归类」岛内的一级页签名（该岛 island 1.5.0 的 stockin 视图 title）',
  // 下面三个是「货与成本」页**自己的页签 / 分段控件**（产品库岛 2026-10-01 收回内建时新增的文案）。
  // 它们不是"去别处的入口"——用户已经在那一页上，只是被指到同页的另一个页签，故按控件处理。
  // 注意豁免是**按名字**生效的：以后真出现一个叫「产品」的别处入口（模块 / 岛），这里必须重新审。
  产品: '「货与成本」页内的页签名（同页三页签之一）',
  供应商: '「货与成本」页内的页签名（同页三页签之一）',
  待关联队列: '「映射与关联」页内的分段控件名（与「已建立映射」互斥，不是另一个页面）',
  // 这两个是「今天 › 拿货」页**自己的分段控件名**（2026-10-05 拿货页签内建时新增的文案）。
  // 与「产品 / 供应商」同例：用户已经在这一步里，只是被指到同页的另一个视图，不是"去别处"。
  拿货单: '「今天 › 拿货」页内的分段控件名（同页两个视图之一：待拿货缺口 / 拿货单）',
  待拿货缺口: '「今天 › 拿货」页内的分段控件名（同页两个视图之一）',
  // 设置页内的**路径描述**（两段都是设置里可见的菜单名）。与上面的「设置 → 插件」同例：
  // 设置分类 / 页签名不在 `known` 的可枚举范围（那三类的取法见 `hostModuleNames` 等），
  // 而它是真入口 —— 真名以 `src/core/settings/panels.ts` 为准（`categoryName: '识别'`，页签「识别引擎」）。
  '设置 → 识别': '设置页内的路径描述（分类「识别」+页签「识别引擎」，见 core/settings/panels.ts）',
  // 「今天 › 结算对账」页**自己的时间窗分段控件名**（同一行里的 全部/今天/本月/本年/自定义）。
  // 与「拿货单 / 待拿货缺口」同例：用户已经在那一页上，只是被指到同页的另一个分段，不是"去别处"。
  全部: '「今天 › 结算对账」页内的时间窗分段控件名（同页五个分段之一）',
};

/** 导航语义的引号名：动词 + 「X」，或「X」+ 页/模块/页签 */
const NAV_PATTERN = /(?:去|在|到|先|从|回)「([^」\n]{1,24})」|「([^」\n]{1,24})」(?:页|模块|页签)/g;

// ⚠️ 扫描**放在 `describe` 体里（收集期执行），不放在 `it` 里**。它把 src/ 整棵树读进内存 +
// 逐字符剥注释，是**固定开销**（I/O + CPU），与用例逻辑无关；只要它在有墙钟预算的 `it` 里，
// 判据就会变成"机器有多忙"而不是"文案有没有悬空"。
// 实测（2026-10-03）：单跑 2.9 s、全量并发时被同机的 `publishGuard`（4 个 fork 子进程 × 约 17 s
// 打包）挤到 > 20 s，报 `Test timed out in 20000ms` —— 不是断言失败，却极容易被读成"文案悬空"。
// 收集期不受 `testTimeout` 管，故把固定开销移到这里；断言本身一字未改，守卫强度不变。
describe('宿主文案里的入口名必须真实存在（悬空名守卫）', () => {
  const files = walk(join(ROOT, 'src'));
  const known = new Set([...hostModuleNames(), ...islandNames(), ...shippingTabNames()]);

  const samples: { file: string; name: string }[] = [];
  for (const file of files) {
    const text = stripComments(readFileSync(file, 'utf-8'));
    let m: RegExpExecArray | null;
    NAV_PATTERN.lastIndex = 0;
    while ((m = NAV_PATTERN.exec(text))) {
      const name = m[1] ?? m[2] ?? '';
      if (!name || name.includes('${')) continue; // 模板拼接的不是固定名
      samples.push({ file: file.slice(ROOT.length + 1), name });
    }
  }

  it('入口名清单本身非空（否则本守卫空转）', () => {
    expect(known.size).toBeGreaterThan(3);
    expect(hostModuleNames()).toContain('今天');
    // 岛名锚点要跟着 `ui-plugins/` 走：原为「订单归类」（该岛 2026-10-05 整体下架）→ 改钉「店铺账号管家」。
    // ⚠️ 这条是**自证非空转**：`islandNames()` 扫不到任何岛时，后面"文案里的岛名全部悬空"就形同虚设。
    expect(islandNames()).toContain('店铺账号管家');
    // 页签名来源也要自证非空转：正则写歪会静默返回 []，于是"页签名全部悬空"这条判据形同虚设
    expect(shippingTabNames()).toContain('生成拣货单');
    expect(shippingTabNames().length).toBeGreaterThan(4);
  });

  it('文案里"让用户去 XXX"的引号名都能对上真实入口', () => {
    // 自证非空转：模式或扫描范围坏掉时会零命中，那与"全部合法"长得一样
    expect(samples.length, '没扫到任何"去「X」"式文案 —— 模式或扫描范围坏了').toBeGreaterThan(0);

    const bad = samples.filter((s) => !known.has(s.name) && !(s.name in ALLOWED_NON_ENTRY));
    expect(
      bad.map((s) => `${s.file}: 「${s.name}」`).join('\n'),
      '文案让用户去一个不存在的入口：改成真实入口名（宿主模块名 / 岛 displayName），' +
        '或若它本就是页面上的控件文字，加进 ALLOWED_NON_ENTRY 并写明理由'
    ).toBe('');
  });
});
