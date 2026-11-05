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
  //
  // ⚠️ 2026-10-17 再补一刀**行级兜底**：上面的逐字符扫描认不出**正则字面量里的引号** ——
  //    `MailInboxView.vue` 有一条 `/["']?\s*(?:https?:)?\/\//` 这样的 URL 正则，
  //    扫描器读到里面的 `"` 就以为进了字符串，之后整段（含 `//` 注释）都不再被剥，
  //    于是一条注释里的「邮件收件箱」被当成用户文案报成悬空名（真踩到）。
  //    修法不是写一个 JS 词法器（这里两处刻意双份、不该长成编译器），而是按**行首标记**兜底：
  //    行首是 `//` / `*` / `/*` 的行一律丢掉。逐字符扫描仍在，两者互为兜底。
  //    代价：行首以 `*` 开头的**代码**也会被丢（本仓没有这种写法）。
  return out
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
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
 * 「发货台」页的**页签名**（`src/modules/today/flowCtx.ts` 的 `SHIPPING_TAB_NAMES`；2026-10-11 由「今天」改名）。
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
  '导入 Excel': '按钮文字（在「发货台」页上就这么写），不是跳转目标',
  刷新: '按钮文字',
  生成待拣清单: '按钮文字（拣货清单工具栏的主按钮；该按钮在「拿货」页签的「按厂家」视图里）',
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
  // 下面几个是「货与成本」页**自己的页签 / 分段控件**（产品库岛 2026-10-01 收回内建时新增的文案）。
  // 它们不是"去别处的入口"——用户已经在那一页上，只是被指到同页的另一个页签，故按控件处理。
  // 注意豁免是**按名字**生效的：以后真出现一个叫「产品」的别处入口（模块 / 岛），这里必须重新审。
  // ⚠️ 2026-10-14「基础数据」整合后，「供应商 / 店铺登记 / 进价」三个页签已搬去
  //    「基础数据」模块（左导航项）—— 它们的豁免**移到下面「基础数据」那一节**，
  //    这里不再重复（同一名字两条豁免 = 改了一处忘了另一处）。「进价」连入口名都不是了
  //    （只剩字段/列名），故彻底撤掉。
  产品: '「货与成本」页内的页签名（同页页签之一；`tabs` 回退形态才有，工作台形态是「款与商品」）',
  // 「款与商品」是「货与成本」在**工作台形态**下的页签名（`tabs.ts` 的 `workbench`）。
  // 2026-10-08 跨页文案收敛时补进来：原先那里写的是「货与成本」的**映射清单**，
  // 而全仓没有任何一处叫「映射清单」（真实名字是页签「款与商品」下的「已建立映射」）。
  // ⚠️ 与「店铺登记」同例：豁免只说明"它是同页的一个页签"，**不代表它一定在** ——
  //    存在性由 `goods:ui` 钉（`.gd-tabs .gd-tab` 里真的点得到「款与商品」）。
  款与商品: '「货与成本」页内的页签名（工作台形态的页签之一；存在性由 goods:ui 断言）',
  // 「常用色」是产品编辑抽屉里 SKU 矩阵**自己那一排的标签字**（`SkuMatrixEditor.vue` 的
  // `.mx-line__k`，就在颜色 chip 正上方）。2026-10-30 加「颜色工作台」后，拖动提示写的是
  // "拖到上面「常用色」= 整组归类 / 归类" —— 指的是这排看得见的色卡，不是另一个页面。
  // 与「款与商品」同例：豁免只说明"它是同屏的控件文字"，**不代表它一定在** ⇒
  // 存在性由 `scripts/goods-ui-smoke.mjs` 钉（`sku-batch-classify` 步：这一排渲染出来、
  // 且真的是拖放落点 —— 落上去后色名真的变成字典写法）。
  常用色: '产品编辑抽屉里 SKU 矩阵那一排色卡的标签字（拖放落点；存在性由 goods:ui 断言）',
  待关联队列: '「映射与关联」页内的分段控件名（与「已建立映射」互斥，不是另一个页面）',
  // 「已建立映射」是同一组分段控件的另一格（2026-10-16「待关联采集商品」段的空态文案
  // 指向它："认款了的采集商品在「已建立映射」里维护"）—— 用户已经在那一页上，
  // 只是被指到同页的另一个分段，与「待关联队列」同例，不是"去别处"。
  // 存在性由 `scripts/goods-ui-smoke.mjs` 钉（`data-act="sub-mapped"` 点得开、真的渲染出映射行）。
  已建立映射: '「货与成本 › 映射与关联」页内的分段控件名（与「待关联队列」同组分段之一）',
  // 「待关联采集商品」是同组第三个分段（2026-10-16 改名，恒列未认款）。产品编辑抽屉
  // 「从采集商品导入」的空态文案指着它（"先到「待关联采集商品」段认款"）——
  // 同「待关联队列 / 已建立映射」：用户已经在那一页上，只是被指到同页的另一个分段。
  // 存在性由 `scripts/goods-ui-smoke.mjs` 钉（`data-act="sub-items"` 点得开、表里真的出采集行）。
  待关联采集商品: '「货与成本 › 映射与关联」页内的分段控件名（与「待关联队列」同组分段之一）',
  // 这两个是「今天 › 拿货」页**自己的分段控件名**（2026-10-05 拿货页签内建时新增的文案）。
  // 与「产品 / 供应商」同例：用户已经在这一步里，只是被指到同页的另一个视图，不是"去别处"。
  // 这个名字出现在「拿货单 #N」编辑器标题 / 清单图标题上 —— 是页面上的可见文字（不是入口）。
  拿货单: '「今天 › 拿货」页的拿货单标题字（编辑器/清单图的标题，不是导航入口）',
  // 「新建包裹」是拆包抽屉里的**按钮文字**（2026-10-21，包裹 B2）：空态那句
  // "先「新建包裹」，再把商品行的件数放进去"指的就是用户眼前这个按钮 —— 不需要去找。
  // 存在性由 `scripts/today-ui-smoke.mjs` 钉（`data-act="pd-new"` 点得开、且真的落库重绘 2 包 → 3 包）。
  新建包裹: '拆包抽屉里的按钮文字（同页可见控件，不是跳转目标；存在性由 today:ui 断言）',
  // 「拆包」是「今天 › 归类核对」每行的**按钮文字**（2026-10-21，包裹 B2）：统计页的运费悬停
  // 说"去「归类核对 › 拆包」补运费"，指的是用户在那一页上点得着的这个按钮（点开出拆包抽屉）。
  // 它不是页签名 —— 抽屉没有独立导航；存在性由 `scripts/today-ui-smoke.mjs` 钉（行内按钮点得开）。
  拆包: '「今天 › 归类核对」行内按钮文字（点开拆包抽屉；存在性由 today:ui 断言）',
  // 「图片」是产品导入模板/导出表的**列名**（表头），不是任何导航入口 ——
  // 提示文案教用户"把图插进「图片」列"时点名的是眼前这张表的列。
  // 存在性由两层钉住：模板表头常量 `PRODUCT_EXPORT_HEADERS`（单测断言含「图片」）+
  // goods:ui 的导入弹层预览表列头断言。列改名时要同步这里。
  图片: '产品导入模板/导出表的列名（表头），提示文案指向用户眼前的这一列',
  // 2026-10-10：拣货清单并进「拿货」后，原「待拿货缺口」那一版视图并掉了 ⇒ 它的豁免**随之撤掉**
  // （留着会让"文案让用户去一个已经不存在的地方"照样通过）。
  // 2026-10-17：「要拿什么 / 拿了什么」两个子视图合并成"一家一卡"后，**那两个名字不再是入口名**；
  // 同日晚间第三轮：**「按订单」页签整条撤掉**（单子管理全在厂家卡"已开单"上）—— 它的豁免随之撤掉，
  // 文案里再写「按订单」就是悬空名，应当直接红（同「货与成本」旧模块名的处置）。
  // 「按厂家」仍是这一页唯一视图的名字。存在性由 `today:ui` 钉（厂家宫格真的渲染出来）。
  按厂家: '「今天 › 拿货」页的唯一视图名（厂家宫格；存在性由 today:ui 断言）',
  // 设置页内的**路径描述**（两段都是设置里可见的菜单名）。与上面的「设置 → 插件」同例：
  // 设置分类 / 页签名不在 `known` 的可枚举范围（那三类的取法见 `hostModuleNames` 等），
  // 而它是真入口 —— 真名以 `src/core/settings/panels.ts` 为准（`categoryName: '识别'`，页签「识别引擎」）。
  '设置 → 识别': '设置页内的路径描述（分类「识别」+页签「识别引擎」，见 core/settings/panels.ts）',
  // 「今天 › 结算对账」页**自己的时间窗分段控件名**（同一行里的 全部/今天/本月/本年/自定义）。
  // 与「拿货单 / 待拿货缺口」同例：用户已经在那一页上，只是被指到同页的另一个分段，不是"去别处"。
  全部: '「今天 › 结算对账」页内的时间窗分段控件名（同页五个分段之一）',
  // ── 「基础数据」模块（2026-10-14 由「店铺账号管家」岛回收 + 整合重设计）──
  // 侧栏现在是**组**（2026-10-17 收拢）：店铺账号 / 产品管理 / 物流运费 / 待补清单；
  // 组内页签名以 `MasterDataView.vue` 的 KINDS 为准。它们与「产品 / 供应商」同例：用户已经在这一模块里，
  // 只是被指到同模块的另一项，不是"去别处"。
  // ⚠️ 豁免只说明"它是同模块的一个控件"，**不代表它真的在** —— 存在性由两层钉住：
  //    `tests/shopAccountsIntake.spec.ts`（组名/页签名/kind id 真的写在视图里）+
  //    `scripts/master-data-ui-smoke.mjs`（逐项点得开、渲染出真的内容）。
  // 2026-10-22（店铺/账号物理合并）：「店铺登记」更名「店名归一」——旧名刻意**不**保留豁免：
  // 文案里再写「店铺登记」就是悬空名，应当直接红。
  店名归一:
    '「基础数据 › 店铺账号」组内页签名（存在性由 shopAccountsIntake + master-data:ui 断言）',
  供应商: '「基础数据」模块左导航的项名（存在性由 shopAccountsIntake + master-data:ui 断言）',
  // 「店铺账号」同例（左导航第一项）。「店铺账号管家」这个**旧模块名**已随整合退役，
  // 刻意**不**进豁免：文案里再写它就是悬空名，应当直接红。
  店铺账号: '「基础数据」模块左导航的项名（存在性由 shopAccountsIntake + master-data:ui 断言）',
  // 「企业」同例（左导航项）。旧页签名「账号库 / 邮件收件箱 / 企业管理」已随
  // 2026-10-14 重设计一并退役（用户可见文案已全部改到新名），故不保留豁免。
  // ⚠️ 2026-10-17：「邮件」**不再需要豁免** —— 它已独立成一级模块（`src/modules/mail/meta.ts`），
  //    名字由 `hostModuleNames()` 兜。这条豁免必须删：本守卫是 `known.has || in ALLOWED`，
  //    两道都放行 ⇒ 留着它等于让"文案指着一个已经不存在的左导航项"照样绿。
  企业: '「基础数据」模块左导航的项名（存在性由 shopAccountsIntake + master-data:ui 断言）',
  // 2026-10-22（物理合并）:「工具账号」= 紫鸟 / ERP 共享登录的维护页（店铺账号组第四个页签）。
  工具账号:
    '「基础数据 › 店铺账号」组内页签名（存在性由 shopAccountsIntake + master-data:ui 断言）',
  // 「产品管理」= 左导航第二项（2026-10-17 深夜由「货品档案」改名，用户口径"货品管理菜单修改为产品管理"）。
  // 同「店铺登记 / 供应商」等例：用户已在「基础数据」模块里，只是被指到左导航的另一项。
  // 存在性由 `master-data:ui` 钉（`kind-goods` 点得开 + `.gd-view` 真的渲染出产品行）。
  // ⚠️ 「货与成本」这个**旧模块名已退役**（`goods/meta.ts` 删除）⇒ 刻意**不**进豁免：
  //    文案里再写它就是悬空名，应当直接红（同「店铺账号管家」的处置）。
  //    「货品档案」同夜随之退役 —— 它也不再进豁免，文案里再写就是悬空名。
  产品管理: '「基础数据」模块左导航的项名（存在性由 master-data:ui 断言）',
  // 2026-11-03：**「图案」不再是任何页面/页签名** —— 用户口径「把产品管理中的图案和发货台的
  // 订花纸功能精简合并，放在现有的订花纸中」，于是 `PatternPanel.vue` 删除、`kind-patterns`
  // 页签撤掉。所以它从豁免表里**移除**：文案里再写「去『图案』」就是悬空名，应当直接红。
  // （它作为普通名词仍到处在用 —— "认图案""图案编号"，NAV_PATTERN 只拦 去/到/在「X」形态。）
  // 「进价」同例（2026-10-17 晚间「成本与费率」→「成本」，深夜再「成本」→「进价」，用户口径"成本修改为进价"）。
  // 「成本」不再是入口名 —— 它只剩普通名词用法（"缺成本""产品成本"），按普通词放行
  // （NAV_PATTERN 只拦 去/到/在「X」或「X」页/页签 的形态，普通名词不命中）。
  进价: '「基础数据」模块组内页签的项名（存在性由 shopAccountsIntake + master-data:ui 断言）',
  // ── 「基础数据 › 物流运费」（2026-10-15 由 UI 岛回收并入第七类资料）──
  // 「无忧物流-标准」是**报价单工作簿里的 sheet 名**（载体报价单名的那张表），不是任何导航入口 ——
  // 与「图片」列名那条同例：提示文案/页签副标题指向用户眼前这份 Excel 的哪一张表。
  // 该 sheet 由导入时 `pickRateSheet` 自动挑出（可切表），**不由本仓定义** ⇒ 换报价单就可能换名，
  // 所以它只能进豁免表，不能进 `known` 的可枚举来源。判据在 `tests/shipRate.spec.ts`（挑表）
  // 与 `scripts/shipping-rate-ui-smoke.mjs`（回执文案带真实 sheet 名）。
  '无忧物流-标准': '报价单工作簿里的 sheet 名（导入时自动挑出、可手动切换），不是导航入口',
  // 「物流运费」是左导航第七项（与上面六项同例：用户已在「基础数据」模块内）。
  // 存在性由 `scripts/master-data-ui-smoke.mjs` 与 `shipping-rate:ui` 断言（逐项点得开 + 渲染真内容）。
  物流运费: '「基础数据」模块左导航的项名（存在性由 master-data:ui + shipping-rate:ui 断言）',
  // 「待补清单」= 第八类资料、也是侧栏第四组（2026-10-19）。同上面几项：用户已在本模块里，
  // 被指到左导航的另一项不是"去别处"。存在性由 `tests/shopAccountsIntake.spec.ts`
  // （组名/kind/渲染分支都在）+ `master-data:ui`（点得开、真的渲染出清单）两层钉住。
  待补清单: '「基础数据」模块左导航的项名（存在性由 shopAccountsIntake + master-data:ui 断言）',
  // 「运费查询」是**物流运费面板自己的第一个页签**（四页签：运费查询 / 运价表 / 按订单试算 / 按产品试算），
  // 另外两个页签的空态文案都在说"先在「运费查询」页导入报价单"——用户已在这个面板里，
  // 只是被指到同面板的另一个页签，与上面的「拿货单」同例。
  // 存在性由 `scripts/shipping-rate-ui-smoke.mjs` 钉（`ship-tab-quote` 点得开 + 默认就停在它上面）。
  运费查询: '「基础数据 › 物流运费」面板内的页签名（四个页签之首；存在性由 shipping-rate:ui 断言）',
  // 2026-10-22（物理合并）:「店铺」**升级成组内页签名**（店铺账号组第一项，kind 'accounts'），
  // 同时仍是数据实体名（店名归一就是把历史店铺名归并到「店铺」）——两种用法都合法。
  店铺: '「基础数据 › 店铺账号」组内页签名（兼作数据实体名；存在性由 shopAccountsIntake + master-data:ui 断言）',
  // 列表行的按钮文字（按需解密复制密码，8 秒后自动隐藏）—— 用户看到它时它就在那一行上。
  临时查看: '「基础数据」列表的按钮文字（按需解密、8 秒自动隐藏）',
  // 邮件服务商**网站**里的设置路径，与「设置 → 插件 / 设置 → 识别」不同：那两条是本应用设置页的路径。
  '设置 → POP3/SMTP/IMAP': '邮件服务商网站（163/126 等）里的设置路径，不是本应用的入口',
  // ── 「记账」模块（2026-10-26，P4）──
  // 「往来」是「记账」页**自己的四个页签之一**（明细 / 往来 / 单店 / 汇总，`LedgerView.vue` 的 `TABS`）。
  // 与「运费查询 / 款与商品」同例：用户已经在这一页上，只是被指到同页的另一个页签，不是"去别处"；
  // 页签名也不在 `known` 的三个可枚举来源里（模块名 / 岛 displayName / 发货台页签）。
  // 存在性由 `scripts/ledger-ui-smoke.mjs` 钉（四个页签逐项点得开）。
  往来: '「记账」页内的页签名（同页四页签之一；存在性由 ledger:ui 断言）',
  // 「相关人 / 科目」是「记账」页**页头右上角的两个按钮**（`data-act="open-parties"` / `open-categories"`，
  // 点开管理弹层）—— 不是导航入口，但文案「记账 › 相关人」读起来最省字，用户抬眼就能点。
  // 豁免只说明"它是本页可见的控件"，**不代表它真的在** ⇒ 存在性由 `scripts/ledger-ui-smoke.mjs` 钉。
  // ⚠️ 换按钮文字时必须同步这里（否则文案里那个名字就悬空了）。
  相关人:
    '「记账」页头按钮文字（`data-act="open-parties"`，打开相关人管理弹层；存在性由 ledger:ui 断言）',
  科目: '「记账」页头按钮文字（`data-act="open-categories"`，打开科目管理弹层；存在性由 ledger:ui 断言）',
  // ── 「图案」模块（2026-11-01 建；**2026-11-02 整页撤并**）──
  // 用户口径「把图案菜单放在基础数据-产品管理-颜色后面…订花纸放在发货台的归类核对后面」，
  // 于是原 `src/modules/pod/` 的三个页签（认图案 / 订花纸 / 花纸库存）不再存在：
  //   · 「订花纸」→ 「发货台」页签（`flowCtx.ts` 的 `SHIPPING_TAB_NAMES.pod`）
  // 2026-11-03 再并一次：用户口径「把产品管理中的图案和发货台的订花纸功能精简合并，放在现有的
  //   订花纸中」⇒ 「图案」页也撤掉（`PatternPanel.vue` 已删），认图案就在「发货台 › 订花纸」。
  // ⇒ 认图案 / 订花纸 / 花纸库存 / 选图案 四个豁免**全部撤掉**：
  //    「订花纸」现在是真页签名（由 `shippingTabNames()` 自动进 `known`），
  //    而本守卫是 `known.has || in ALLOWED` —— 两道都放行等于放过指向不存在的入口；
  //    另外三个名字已无任何用户可见文案使用，文案里若再出现就是悬空名，应当直接红。
};

/**
 * 路径式入口名（`A › B`）—— 2026-10-17 起真实存在：模块里再分资料项之后，
 * 文案写「基础数据 › 货品档案」比"「基础数据」的「货品档案」"更短也更像用户嘴里的说法。
 * 判据不是"整串在清单里"，而是**每一段**都得是真实入口名（模块 / 岛 / 页签 / 豁免的项名）。
 * ⚠️ 分隔符只认 ` › `（U+203A，前后各一空格）—— 与文案里真用的那一个一致。
 *    写成 `>` `/` `→` 都不算路径，会按"整串是一个名字"判，于是照样红（宁可红，不要静默放行）。
 */
const PATH_SEP = ' › ';
function entryParts(name: string): string[] {
  const parts = name.split(PATH_SEP).map((x) => x.trim());
  return parts.length > 1 ? parts : [name];
}

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

  // ⚠️ 显式 timeout：这条用例本身是**同步读盘 + 逐字符扫描**（`hostModuleNames` / `islandNames`
  //    各扫一遍目录，describe 顶部那句 stripComments 还要过一遍全部源码）。单跑 0.6s，
  //    但 40 个 worker 并行 + 机器上同时有别的写盘活（曾与 `npm run verify` 撞上）时
  //    实测 5.9s > 默认 5s ⇒ 报 `Test timed out`，看起来像断言失败，其实什么都没坏。
  //    同一类问题在 fork 子进程的用例上踩过（见 .workbuddy/memory/MEMORY.md）。
  it('入口名清单本身非空（否则本守卫空转）', () => {
    expect(known.size).toBeGreaterThan(3);
    expect(hostModuleNames()).toContain('发货台');
    // 岛名锚点要跟着 `ui-plugins/` 走：原为「订单归类」（该岛 2026-10-05 整体下架）
    // → 改钉「店铺账号管家」→ 该岛 2026-10-14 **回收为内建模块并更名「基础数据」**
    // ⇒ 锚点下移到「TV模版」。
    // ⚠️ 这条是**自证非空转**：`islandNames()` 扫不到任何岛时，后面"文案里的岛名全部悬空"就形同虚设。
    expect(islandNames()).toContain('TV模版');
    // 回收更名后的模块名必须是合法入口名（文案里"去「基础数据」"要能对上；「店铺账号管家」
    // 这个旧名已随整合退役 —— 用户可见文案里再出现它就是悬空名，本守卫按悬空报）。
    expect(hostModuleNames()).toContain('基础数据');
    // 页签名来源也要自证非空转：正则写歪会静默返回 []，于是"页签名全部悬空"这条判据形同虚设
    // ⚠️ 锚点跟着页签定义走：原为「生成拣货单」（该页签 2026-10-10 并进「拿货」，六步 → 五步）。
    expect(shippingTabNames()).toContain('拿货');
    expect(shippingTabNames().length).toBeGreaterThan(4);
    // ⚠️ 2026-10-17：算钱整步撤出发货台（归拢到独立模块、并改名「统计」）⇒ 它**不再是页签名**。
    //    留着的话，文案里写「去「算钱」页签」照样通过，而那一页已经点不到了。
    //    反向那一半（「统计」是合法入口名）由上面的 hostModuleNames 兜：它的名字在 meta.ts 里。
    expect(shippingTabNames()).not.toContain('算钱');
    expect(hostModuleNames()).toContain('统计');
    // ⚠️ 2026-10-17 的两处结构改动，各钉一条反向断言（正向的那一半由上面两条兜）：
    //    ① 「邮件」独立成一级模块 ⇒ 它必须是**模块名**（否则文案"去「邮件」"无处可去）；
    //    ② 「货与成本」并入「基础数据 › 货品档案」⇒ 它**不再是模块名**，
    //       文案里再写它就是悬空名（豁免表里也刻意没有它）。
    expect(hostModuleNames()).toContain('邮件');
    expect(hostModuleNames()).not.toContain('货与成本');
    // ⚠️ 2026-11-02「图案」整页撤并（11-03 再并进订花纸），正反两半也各钉一条：
    //    ① 「订花纸」搬进发货台 ⇒ 它必须是个**页签名**（文案"去「订花纸」"要能对上）；
    //    ② 「图案」不再是独立模块、也不再是页签名 ⇒ 不是模块名，文案里再写「图案」入口就是悬空名。
    expect(shippingTabNames()).toContain('订花纸');
    expect(hostModuleNames()).not.toContain('图案');
  }, 30000);

  it('文案里"让用户去 XXX"的引号名都能对上真实入口', () => {
    // 自证非空转：模式或扫描范围坏掉时会零命中，那与"全部合法"长得一样
    expect(samples.length, '没扫到任何"去「X」"式文案 —— 模式或扫描范围坏了').toBeGreaterThan(0);

    const isEntry = (name: string) => known.has(name) || name in ALLOWED_NON_ENTRY;
    const bad = samples.filter((s) => !entryParts(s.name).every(isEntry));
    expect(
      bad.map((s) => `${s.file}: 「${s.name}」`).join('\n'),
      '文案让用户去一个不存在的入口：改成真实入口名（宿主模块名 / 岛 displayName），' +
        '或若它本就是页面上的控件文字，加进 ALLOWED_NON_ENTRY 并写明理由'
    ).toBe('');
  });
});
