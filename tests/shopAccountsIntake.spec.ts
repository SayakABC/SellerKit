// tests/shopAccountsIntake.spec.ts
//
// 「基础数据」模块的结构守卫（2026-10-14；原名「店铺账号管家」，岛 → 内建 → 整合重设计）。
//
// 为什么值得单独立一条：这次改动横跨**四个各自独立的东西**，任一处漏掉都不会报错，只会静默失效：
//   ① 岛目录必须真的消失 —— `scripts/lib/module-roots.cjs` 的 `isUndocked()` 只看
//      `ui-plugins/<id>` **是否存在**；留着它，`vite.config.ts` 会把该 id 从 registry 里硬拦（只打一行 error），
//      表现为"模块写了却永远进不了包"。
//   ② 模块必须登记进 `modules.config.json` 的**三个**清单（两个预设 + 兜底），只改一处会在某个预设下静默缺失。
//   ③ 侧栏结构是**字符串跨文件协议**：`meta.parent` 指向 `nav.ts` 的分组（写错 = 菜单不出来），
//      一级入口则要求 `parent` **缺席**（2026-10-14 起本模块升为一级入口「基础数据」）。
//   ④ 模块源码里不得再残留**桥形态**（`window.__sk` / `../api.js` / `useIslandToasts`）：
//      桥只存在于 iframe 岛里，留在内建模块里就是"看着能跑、其实那条路已经不通"。
//
// 另有"整合重设计"专属的几条（2026-10-14 新增）：
//   · 左导航六项的名字与 id 必须真的写在视图里 —— 它们是 `uxEntryNames` 豁免名单的存在性锚点；
//   · 跨模块跳转（`switchModule('shop-accounts', action)`）落地的 kind id 必须在同一个清单里；
//   · 「货与成本」页**不再有**登记 / 供应商 / 进价三个页签（搬来了才叫整合，漏一处 = 两个入口）。
//
// ⚠️ 扫描型断言必须**自证非空转**：每个扫描面都在末尾断言"至少扫到了 N 个"，否则模式写歪 = 恒绿。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_DIR = join(ROOT, 'src', 'modules', 'shop-accounts');
const ISLAND_DIR = join(ROOT, 'ui-plugins', 'shop-accounts');

/** 递归列出模块下全部源码文件 */
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(vue|ts|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const moduleFiles = walk(MODULE_DIR);

// ⚠️ 固定 I/O 全部在**模块作用域**做完，`it` 里只断言 —— 本机 FS 在 vitest 下读这 20+ 个文件
// 要 ~5s（独立 node 下仅 0.5s），写在 `it` 里会顶穿 5s 默认超时，报出来却像"守卫失败"
// （2026-10-03 踩过同型坑；2026-10-15 模块从 18 文件涨到 26 文件后复发）。
// 记忆化：本文件多处扫描读同一批文件，只读一遍。
const _srcCache = new Map<string, string>();
function readSrc(f: string): string {
  let s = _srcCache.get(f);
  if (s === undefined) {
    s = readFileSync(f, 'utf-8');
    _srcCache.set(f, s);
  }
  return s;
}
const readAll = (): string => moduleFiles.map(readSrc).join('\n');
const allSrc = readAll();

/** `src/core/services/ipc.ts` 导出的成员名 */
function ipcExports(): Set<string> {
  const src = readSrc(join(ROOT, 'src', 'core', 'services', 'ipc.ts'));
  const names = new Set<string>();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s+const\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  return names;
}

/** 模块源码里从 `@/core/services/ipc` 导入的成员名（含多行花括号形式） */
function importedIpcNames(): string[] {
  const out: string[] = [];
  for (const f of moduleFiles) {
    const src = readSrc(f);
    for (const m of src.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@\/core\/services\/ipc'/g,
    )) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name) out.push(name);
      }
    }
  }
  return out;
}

// 同上：两次全量扫描的结果也在模块作用域算好（`it` 只断言）。
const ipcExportsSet = ipcExports();
const ipcUsed = importedIpcNames();

describe('基础数据：岛 → 内建 → 整合重设计的结构', () => {
  it('岛目录已删除（否则 isUndocked 为真，模块永远打不进包）', () => {
    expect(existsSync(ISLAND_DIR)).toBe(false);
  });

  it('模块登记进 modules.config.json 的 presets + 兜底清单', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'modules.config.json'), 'utf-8')) as {
      profiles?: Record<string, string[]>;
      enabledModules?: string[];
    };
    expect(cfg.profiles?.standard).toContain('shop-accounts');
    expect(cfg.profiles?.pro).toContain('shop-accounts');
    expect(cfg.enabledModules).toContain('shop-accounts');
    // 空预设是"纯外壳"的有意表达，回收不得把它填满（历史缺陷：空预设被静默回落）
    expect(cfg.profiles?.minimal).toEqual([]);
  });

  it('registry 已收录该模块与它的设置面板（构建产物存在时才有意义）', () => {
    const p = join(ROOT, 'src', 'registry.generated.ts');
    if (!existsSync(p)) return; // 未构建过：本用例不适用（守卫不依赖构建顺序）
    const src = readFileSync(p, 'utf-8');
    expect(src).toContain("'shop-accounts': () => import('@/modules/shop-accounts/index')");
    expect(src).toContain("'shop-accounts': () => import('@/modules/shop-accounts/settings')");
  });

  it('侧栏：一级入口「基础数据」（无 parent；「店铺管理」分组已随之撤销）', () => {
    const meta = readFileSync(join(MODULE_DIR, 'meta.ts'), 'utf-8');
    // 2026-10-14 整合：从「店铺管理」分组下的子项升为**一级入口**（维护功能不该藏在二级菜单里）
    expect(/parent:\s*'/.test(meta), 'meta.ts 不得再声明 parent（那会把它变回二级项）').toBe(false);
    expect(/name:\s*'基础数据'/.test(meta), 'meta.name 必须是「基础数据」').toBe(true);

    const nav = readFileSync(join(ROOT, 'src', 'core', 'nav.ts'), 'utf-8');
    // 分组整个撤掉：留着空分组会在侧栏渲染一个点不开的标题
    expect(nav.includes("'店铺管理'"), 'nav.ts 里不该再有「店铺管理」分组').toBe(false);
    // 顺序：**维护与读信排在业务页之前**（原来的比法是"基础数据 < 货与成本"）。
    // ⚠️ 2026-10-17「货与成本」并入本模块（左导航第二项「货品档案」）⇒ 那个 meta 文件不存在了，
    //    再读它就是 ENOENT。改成与紧跟其后的两个一级入口比：
    //    邮件(读信) 与 统计(看钱) 都应排在基础数据之后 —— 用户先进来维护资料，再去看数。
    // ⚠️ 窗口别收得太紧：`id` 到 `order` 之间隔着几段说明注释，2026-10-17 加了两段之后
    //    原来 200 字符的窗口就够不着 `order: 2` 了 —— 表现为 `orderSelf` 变 NaN、
    //    下面那条"自证非空转"的断言红（幸好有它，否则 `NaN < x` 恒 false 也一样红得莫名其妙）。
    const orderSelf = /id:\s*'shop-accounts'[\s\S]{0,800}?order:\s*(\d+)/.exec(meta)?.[1];
    const orderOf = (id: string): number => {
      const m = readFileSync(join(ROOT, 'src', 'modules', id, 'meta.ts'), 'utf-8');
      return Number(/order:\s*(\d+)/.exec(m)?.[1]);
    };
    expect(Number(orderSelf)).toBeGreaterThan(0);
    expect(Number(orderSelf)).toBeLessThan(orderOf('mail'));
    expect(Number(orderSelf)).toBeLessThan(orderOf('order-cost'));
  });

  it('模块源码不残留桥形态（window.__sk / 自造 api 桩 / 岛内 toast 队列）', () => {
    const src = allSrc;
    expect(moduleFiles.length).toBeGreaterThan(10); // 自证非空转
    for (const bad of ['window.__sk', "'../api.js'", "'./bridge.js'", 'useIslandToasts', '__sk']) {
      expect(src.includes(bad), `模块源码里仍有 ${bad}（那是 iframe 岛专用的桥，内建模块走 @/core/services/*）`).toBe(
        false,
      );
    }
  });

  it('调用的宿主 ipc 成员全部真实存在（岛时代有自造桩，写错名字照样构建通过）', () => {
    const exports = ipcExportsSet;
    const used = ipcUsed;
    expect(exports.size).toBeGreaterThan(50); // 自证非空转：解析 ipc.ts 导出
    expect(used.length).toBeGreaterThan(20); // 自证非空转：解析模块的 import
    expect(used.filter((n) => !exports.has(n))).toEqual([]);
  });

  it('设置分类 id 只有 settings.ts 一个来源（视图不再自己打开设置）', () => {
    // 原判据是"视图入口与 settings.ts 贡献这两处 id 一致"（2026-10-14 岛回收时立的）。
    // 2026-10-17 下午：二级菜单里那行「设置」按用户口径去掉 ⇒ 视图**不再有**打开设置的动作，
    // 没有第二处可比了。改守真正容易出错的那件事：分类 id 只有 settings.ts 一个来源，
    // 视图里不再写死它（写死了就是第二来源 —— 改名时静默不一致，表现为"点了没反应"）。
    const settings = readFileSync(join(MODULE_DIR, 'settings.ts'), 'utf-8');
    const fromSettings = /categoryId:\s*'([^']+)'/.exec(settings)?.[1];
    expect(fromSettings, 'settings.ts 没注册分类 id（设置中心里就没有「基础数据」这一栏）').toBe(
      'shop-accounts:settings'
    );
    const view = readFileSync(join(MODULE_DIR, 'MasterDataView.vue'), 'utf-8');
    expect(view.includes("openSettings('"), '视图又开始自己打开设置了（入口是设置中心底部齿轮）').toBe(false);
  });

  it('八类资料的名字与 kind id 真的写在视图里（uxEntryNames 豁免的存在性锚点）', () => {
    // 八项 = 整合后"基础数据维护"的全部内容（2026-10-22 进价页退役后，cost 不在清单）。
    // 豁免**只说明它是控件、不代表它存在**；删掉一项而文案还指着它，那种悬空由这里兜住。
    // ⚠️ 2026-10-17：清单从六项变七项 —— 「邮件」搬出去（独立模块，其名改由 hostModuleNames 兜），
    //    「货品档案」（原「货与成本」整页）搬进来。清单是本文件的断言正文，改结构时必须同批改。
    // ⚠️ 同日第二件事：这七项的**按钮**从页面内左导航搬到主侧栏（本视图只负责上报），
    //    所以「名字/id/渲染分支在视图里」与「data-act 的生成处在侧栏」是两条断言，别混。
    // ⚠️ 同日第三件事（收拢成三组）：`accounts` 与 `goods` 两项**变了读法** ——
    //    组名是「店铺账号 / 产品管理」，组内页签名是「店铺 / 款与商品」。
    //    名字因此分两处：组名在 GROUPS，页签名在 KINDS（`goods` 那项取 `GOODS_TAB_LABEL`，
    //    不写裸字面量 —— 与「产品管理」页签条同一个来源）。
    // ⚠️ 2026-10-22（店铺/账号物理合并）：「账号库」更名「店铺」、「店铺登记」更名「店名归一」，
    //    并新增「工具账号」页签（紫鸟/ERP 共享登录）。清单仍是本文件的断言正文，改结构必须同批改。
    const view = readFileSync(join(MODULE_DIR, 'MasterDataView.vue'), 'utf-8');
    // 侧栏三项（组）的名字
    const groups = [
      { id: 'accounts', name: '店铺账号' },
      // 2026-10-17 深夜（用户口径）：组名「货品档案」改「产品管理」
      { id: 'goods', name: '产品管理' },
      { id: 'shipping', name: '物流运费' },
      // 2026-10-19：第四组「待补清单」——跨域汇总"资料还欠什么"（`HealthPane.vue`）。
      { id: 'health', name: '待补清单' },
    ];
    expect(
      groups.filter((g) => !view.includes(`name: '${g.name}'`)).map((g) => g.name),
      '侧栏组名不在视图里了：uxEntryNames 的豁免需要同步撤销'
    ).toEqual([]);
    // 组内页签名（有字面量的那六项；`goods` 走常量，见下）
    const kinds = [
      { id: 'accounts', name: '店铺' },
      { id: 'registry', name: '店名归一' },
      { id: 'companies', name: '企业' },
      // 2026-10-22（物理合并）：紫鸟/ERP 共享登录从店铺行里抽出，独立成第四个页签
      { id: 'tools', name: '工具账号' },
      { id: 'suppliers', name: '供应商' },
      { id: 'shipping', name: '物流运费' },
      // 2026-10-19：单页组「待补清单」（组名与页签名同名 —— 它不属于任何既有组，
      // 六类检查里有两类在订单侧，塞进「产品管理」会让组名说谎）。
      { id: 'health', name: '待补清单' },
    ];
    expect(
      kinds.filter((k) => !view.includes(`name: '${k.name}'`)).map((k) => k.name),
      '页签名不在视图里了（组内页签条会缺一格）'
    ).toEqual([]);
    // `goods` 的页签名必须来自 `GOODS_TAB_LABEL`：写第二遍就迟早与那边漂开
    expect(
      view.includes('name: GOODS_TAB_LABEL.workbench'),
      '「款与商品」的文案没走 GOODS_TAB_LABEL（两处各写一遍 = 必然漂开）'
    ).toBe(true);
    // 与项一一对应的 kind id 也要在（KINDS 是唯一清单：上报、内容分支、跨模块 action 都吃它）
    for (const k of [...kinds, { id: 'goods', name: '款与商品' }]) {
      expect(view.includes(`'${k.id}'`), `kind id ${k.id} 不在视图里`).toBe(true);
      // 渲染分支：八项各有一个 v-if / v-else-if（少一个 = 点下去一片空白）
      expect(view.includes(`kind === '${k.id}'`), `资料页 ${k.id} 没有渲染分支`).toBe(true);
    }
    // data-act 的**生成处**：侧栏那一层是组（AppShell 生成 `kind-<groupId>`），
    // 页内页签是资料页（本视图生成 `kind-tab-<kindId>`）。两套锚点必须都在，且不重名。
    const shell = readFileSync(join(ROOT, 'src', 'core', 'AppShell.vue'), 'utf-8');
    expect(
      shell.includes('`kind-${it.id}`'),
      '侧栏二级项的 data-act 不再是 kind-<id>（锚点名变了，冒烟会静默失配）'
    ).toBe(true);
    expect(
      view.includes('`kind-tab-${k.id}`'),
      '组内页签的 data-act 不再是 kind-tab-<id>（锚点名变了，冒烟会静默失配）'
    ).toBe(true);
  });

  it('三组把八类资料**一个不漏**地装进去（少一个 = 那一页没有入口）', () => {
    // 2026-10-17 收拢（用户口径「店铺登记、企业收拢到店铺账号；成本与费率、供应商收拢到货品档案」）。
    // 这条守的是一件很安静的事：`GROUPS[].kinds` 漏掉一项，那一页**照样实现、照样能渲染**，
    // 只是侧栏没有入口了 —— 用户永远走不到它，日志里一个错都没有。
    const view = readFileSync(join(MODULE_DIR, 'MasterDataView.vue'), 'utf-8');
    const block = /const GROUPS: GroupDef\[\] = \[([\s\S]*?)\n\];/.exec(view)?.[1] ?? '';
    expect(block.length, '没解析到 GROUPS（正则写歪了 = 这条恒绿）').toBeGreaterThan(80);
    const grouped = [...block.matchAll(/kinds: \[([^\]]*)\]/g)].flatMap((m) =>
      [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    );
    expect(grouped.slice().sort()).toEqual([
      'accounts',
      'companies',
      'goods',
      'health',
      'registry',
      'shipping',
      'suppliers',
      'tools',
    ]);
  });

  it('三组都上报给主侧栏（不上报 = 菜单只剩一行「基础数据」）', () => {
    // 2026-10-17：资料从页面内左导航搬到主侧栏，视图与侧栏之间只剩**一条上报**这条线。
    // 这条线断掉的形态特别安静：页面本身完全正常（内容区照常切换），只是侧栏里没有那一串菜单。
    const view = readFileSync(join(MODULE_DIR, 'MasterDataView.vue'), 'utf-8');
    expect(view.includes("reportSubNav('shop-accounts'"), '没上报 = 侧栏永远画不出二级菜单').toBe(true);
    // 数据源必须是 GROUPS 那一份 —— 另抄一份清单就迟早与内容分支不一致
    // （同 2026-10-08 撤指标条的理由）。2026-10-17 收拢后侧栏画的是**组**，所以是 GROUPS。
    expect(
      /items:\s*\(\)\s*=>\s*GROUPS\.map\(/.test(view),
      'items 必须由 GROUPS 派生，不是另抄一份清单'
    ).toBe(true);
    // 当前项高亮的是**组**（侧栏只有组；具体停在哪一页由组内页签自己表达）
    expect(
      view.includes('activeId: () => currentGroup.value.id'),
      '当前项没上报 = 侧栏不知道高亮谁'
    ).toBe(true);
    // 组页签条只在"这一组多于一项"时才画：单页组（物流运费）画出来就是一条没用的条
    expect(
      view.includes('v-if="groupKinds.length > 1"'),
      '组内页签条的渲染条件不见了（单页组会长出一条空格子页签条）'
    ).toBe(true);
    // 2026-10-17 下午：原第 8 行「设置」按用户口径**去掉**（"二级菜单中的设置去掉"）。
    // 反向断言：它回来了就是错的 —— 设置入口是宿主设置中心（侧栏底部齿轮），不是第八类资料。
    expect(view.includes('settings: {'), '「设置」入口不该再挂在二级菜单里').toBe(false);
    expect(view.includes('openHostSettings'), 'openHostSettings 已无用（设置入口撤掉了），不该留死代码').toBe(false);
    // meta 的布尔：模块还没打开过时，侧栏也画得出展开箭头（内容仍由上报给）
    const meta = readFileSync(join(MODULE_DIR, 'meta.ts'), 'utf-8');
    expect(/subNav:\s*true/.test(meta), 'meta 没声明 subNav = 首次进模块前侧栏没有展开箭头').toBe(true);
  });

  it('二级菜单能靠点一级项收起（判据必须是渲染条件，不只是箭头）', () => {
    // 用户口径 2026-10-17：「现在点击基础数据没法收起二级菜单」。
    // 原来展开态只由"是否在这个模块里"决定，点自己那次 activate 会被 activateCore 早退掉
    // ⇒ 除了切走没有任何收起手段。修法是给渲染判据加第三个条件（没被手动收起）。
    //
    // 为什么断言源码：这条行为需要真实挂载外壳才验得出，而 `master-data:ui` 已经用 DOM 事实
    // 双向往返验了（收起 → 七项消失 → 再点回来）。单测这层只钉"判据挂在渲染条件上"这一件事：
    // 只把箭头转个方向、那七行照旧占高度的实现，能通过任何只查 aria-expanded 的断言。
    const shell = readFileSync(join(ROOT, 'src', 'core', 'AppShell.vue'), 'utf-8');
    expect(
      /subCollapsedFor\.value !== m\.id/.test(shell),
      '手动收起没参与"画不画子项"的判据 = 收起后仍占着那 288px'
    ).toBe(true);
    expect(
      shell.includes('@click="onModuleRow(row)"'),
      '一级项仍直接调 activate = 同模块早退，点它永远收不起来（原 bug）'
    ).toBe(true);
    expect(
      /subCollapsedFor\.value = subCollapsedFor\.value === row\.id \? '' : row\.id/.test(shell),
      'onModuleRow 没有"再点一次展开"的往返（做成单向死路）'
    ).toBe(true);
    // 切模块必须清掉：否则"收起 → 去别处 → 点回来"会看到一行空菜单，
    // 与用户选定的"点进去才展开"正好相反，而且没有任何提示。
    expect(
      shell.includes("if (id !== activeId.value) subCollapsedFor.value = ''"),
      '切模块没清手动收起 = 切回来菜单是空的'
    ).toBe(true);
  });

  it('subNav 在 meta → spec → meta 的往返里不会丢（两处白名单都得抄）', () => {
    // 这条看着像"断言源码里有两行字"，但它是唯一能拦住下面这个故障的东西：
    // `ModuleMeta.subNav` 是**可选字段**，而这两处映射都是字面量白名单 ——
    // 少抄一处，模块写的 true 在到达 AppShell 之前静默消失，TypeScript 一句话都不报。
    // 2026-10-17 建这个字段时就踩了一次：侧栏七项怎么都不出现，日志里没有任何报错，
    // 排查一路走到 `metasFromContributions` 才发现字段被白名单吃了。
    const discover = readFileSync(join(ROOT, 'src', 'core', 'plugin', 'managerDiscover.ts'), 'utf-8');
    const manager = readFileSync(join(ROOT, 'src', 'core', 'plugin', 'pluginManager.ts'), 'utf-8');
    expect(discover.includes('subNav: meta.subNav'), 'managerDiscover 没把 meta.subNav 抄进 spec').toBe(true);
    expect(manager.includes('subNav: c.spec.subNav'), 'metasFromContributions 没把 spec.subNav 抄回 meta').toBe(
      true
    );
  });

  it('跨模块跳转落地的 kind 与左导航同一份清单（switch-module action）', () => {
    // 别处（「货与成本」的「现在登记」等）用 switchModule('shop-accounts', action) 跳进来。
    // action 字符串与 kind id 是**跨模块字符串协议**：写错不报错，表现为"跳过去停在上次那一项"。
    const view = readFileSync(join(MODULE_DIR, 'MasterDataView.vue'), 'utf-8');
    expect(view.includes("detail.moduleId !== 'shop-accounts'")).toBe(true);
    // 落地时必须校验 action 是真 kind（否则任意字符串都能当选项 = 静默无变化）
    expect(/KINDS\.some\(\(k\) => k\.id === id\)/.test(view), 'selectKind 必须校验 id 在 KINDS 里').toBe(true);
  });

  it('组 id 与 kind id 撞车：两个入口分函数，页签不许按组解释（2026-10-17 当晚 bug 回归）', () => {
    // 用户口径（收拢当晚）：「店铺账号和货品档案中切换 tab 不正常」。
    // 根因：组 id 与 kind id 有**两个字面量撞车** —— 组 'accounts' ⇄ kind 'accounts'、
    // 组 'goods' ⇄ kind 'goods'。旧实现一个函数先查组表再接 kind 表，于是在组内点
    // **第一页页签**（「店铺」/「款与商品」）被解释成"点组名"，命中"已在这组"的
    // 早退 ⇒ 页面什么都不发生（无报错、无变化，最难查的失败形态）。
    // 修法：入口按来源拆函数 —— 侧栏传组 id 走 selectGroup，页签传 kind id 走 selectKind。
    const view = readFileSync(join(MODULE_DIR, 'MasterDataView.vue'), 'utf-8');
    // ① 页签点击走 selectKind
    expect(view.includes('@click="selectKind(k.id)"'), '页签点击没走 selectKind（入口接错了）').toBe(true);
    // ② selectKind 体内不许出现 GROUPS：按 kind 解，不按组解。
    //    "已在这组就早退"是**组点击**的语义，套到页签上就是把用户点击吞掉。
    const kindFn = /function selectKind\(id: string\): void \{([\s\S]*?)\n\}/.exec(view)?.[1] ?? '';
    expect(kindFn.length, '没解析到 selectKind 函数体（正则写歪了 = 这条恒绿）').toBeGreaterThan(20);
    expect(kindFn.includes('GROUPS'), 'selectKind 又按组解释了：组内点第一页页签会被早退吞掉').toBe(false);
    // ③ 侧栏 onSelect 走 selectGroup，且 selectGroup 校验的是组表
    expect(view.includes('onSelect: (id) => selectGroup(id)'), '侧栏 onSelect 没走 selectGroup').toBe(true);
    const groupFn = /function selectGroup\(id: string\): void \{([\s\S]*?)\n\}/.exec(view)?.[1] ?? '';
    expect(groupFn.length, '没解析到 selectGroup 函数体（正则写歪了 = 这条恒绿）').toBeGreaterThan(20);
    expect(groupFn.includes('GROUPS.find'), 'selectGroup 没在校验组 id').toBe(true);
    // ④ 跨模块 action 两种都可能：先按 kind 解（'accounts'/'goods' 两种解释同页），
    //    落空再按组解。老路"一个函数先查组表"不许回来。
    expect(
      /if \(KINDS\.some\(\(k\) => k\.id === action\)\) selectKind\(action\);\s*\n\s*else selectGroup\(action\);/.test(
        view
      ),
      'applySwitchAction 没按"先 kind 后组"解析（或又合并成一个双 id 函数）'
    ).toBe(true);
  });

  // 2026-10-22（B'）：「基础数据 › 进价」整页退役（`CostPane`/`RatesPane`/`CostRatesPane` 三文件删除），
  // 进价维护收归产品编辑抽屉 + 产品列表「只看缺进价」筛选。原钉「进价表六列 / 区间锚点不残留」
  // 的那条用例随之删除（它读 `CostPane.vue`，文件已不存在 ⇒ ENOENT）。进价页不复存在的反向守卫
  // 改由 `master-data:ui` 的「成本维护已收回」断言 + 本文件「八类资料」/「三组」两条（cost 不在清单）兜住。
  it('「货与成本」不再有登记 / 供应商 / 进价页签（整合的反面：漏一处 = 两个入口）', () => {
    const goodsView = readFileSync(join(ROOT, 'src', 'modules', 'goods', 'GoodsView.vue'), 'utf-8');
    for (const tab of ["'registry'", "'suppliers'", "'cost'"]) {
      expect(goodsView.includes(`id: ${tab}`), `GoodsView 的页签表里还有 ${tab}（应已搬进基础数据）`).toBe(false);
    }
    // 组件导入也要一并消失（留着 import 会让 vite 把它打进包里，白占体积）
    for (const comp of ['ShopRegistryView', 'SupplierView', 'CostPane']) {
      expect(goodsView.includes(comp), `GoodsView 还在 import ${comp}`).toBe(false);
    }
    // 行内出口改为**跨模块跳转**（不是删掉了事 —— 删了出口，队列里"店铺未归一"的行就成了死路）
    expect(goodsView.includes("switchModule('shop-accounts', 'registry')")).toBe(true);
  });
});

describe('基础数据：回收后不再有岛专属产物', () => {
  it('模块目录下没有岛时代的产物/配置（dist / manifest.json / vite.config / package.json）', () => {
    expect(moduleFiles.length).toBeGreaterThan(10); // 自证非空转
    for (const f of ['dist', 'manifest.json', 'vite.config.mjs', 'package.json', 'settings.html']) {
      expect(existsSync(join(MODULE_DIR, f)), `模块目录里不该再有 ${f}`).toBe(false);
    }
    // 反面兜底：模块目录确实存在（避免上面那条因为"目录都没了"而恒真）
    expect(statSync(MODULE_DIR).isDirectory()).toBe(true);
  });
});
