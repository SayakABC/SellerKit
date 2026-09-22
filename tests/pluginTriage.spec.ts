// 插件下记（内建 → UI 岛）的结构化守卫。
//
// 背景（2026-09-21 真实故障）：order-insight 的 UI 岛早就建好并可从市场安装，
// 但 modules.config.json 的 standard/pro 预设里仍登记着同名内建视图包。
// managerDiscover.discover() 先按预设把内建 id 写进 records，随后 registerUiIsland()
// 见 records.has(id) 就直接 return —— 岛装上了、市场显示"已安装"，却永远没有侧栏入口，
// 只在 console 留一条 warn（AGENTS 红线 23）。
//
// 这三条断言把"下记"这个动作钉死成可回归的结构约束：
//   1) 预设清单与 ui-plugins/ 目录名不得有交集（下记必须真实发生）；
//   2) 岛源码里的 db op 调用必须全部在 manifest 里声明（否则运行时才报越权）；
//   3) 岛的 manifest.name 必须与目录名一致（否则市场/manifest 两处 id 漂移）。
//
// 另有一组反向断言（2026-09-22 补）：内建下记后，岛的**能力缺口**不会让它变"死件"却无提示。
//   "调用 ⊆ 声明"只管越权，管不了"声明了却从没调用" —— 后者是下记后的主要回退形态，故另立一组。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

/** ui-plugins/ 下的岛目录名（= 岛屿 id） */
const islandIds = (): string[] => {
  const dir = resolve(root, 'ui-plugins');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith('.') && statSync(resolve(dir, n)).isDirectory())
    .sort();
};

/** 递归列出目录下全部文件 */
const walk = (dir: string, acc: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
};

type IslandManifest = {
  name?: string;
  capabilities?: Array<{ id?: string; domains?: string[]; actions?: string[] }>;
};

const readManifest = (id: string): IslandManifest =>
  JSON.parse(readFileSync(resolve(root, 'ui-plugins', id, 'manifest.json'), 'utf-8'));

describe('内建预设不得占用 UI 岛的 id（AGENTS 红线 23）', () => {
  const cfg = JSON.parse(readFileSync(resolve(root, 'modules.config.json'), 'utf-8')) as {
    profiles?: Record<string, string[]>;
    enabledModules?: string[];
  };

  it('modules.config.json 声明的模块 id 与 ui-plugins/ 目录名无交集', () => {
    const declared = [
      ...Object.values(cfg.profiles ?? {}).flat(),
      ...(cfg.enabledModules ?? []),
    ];
    const ids = islandIds();
    expect(ids.length).toBeGreaterThan(0); // 至少存在一个岛，否则本断言空转
    expect(declared.filter((id) => ids.includes(id))).toEqual([]);
  });

  it('构建产物注册表中不自带任何 UI 岛（下记后一律由市场安装）', () => {
    const reg = resolve(root, 'src/registry.generated.ts');
    if (!existsSync(reg)) return; // 未构建时跳过，避免把守卫变成构建步骤的硬依赖
    const text = readFileSync(reg, 'utf-8');
    const leaked = islandIds().filter((id) => text.includes(`'${id}'`));
    expect(leaked).toEqual([]);
  });
});

/** 剥掉注释（守卫必须看真实代码：注释里出现的同名字符串会让断言假通过 —— 见 §reclassify 注释） */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 某个岛的全部源码文本（dist 为准，回退 src），已剥注释 */
const islandSource = (id: string): string => {
  const parts: string[] = [];
  for (const sub of ['dist', 'src']) {
    const dir = resolve(root, 'ui-plugins', id, sub);
    if (!existsSync(dir)) continue;
    for (const f of walk(dir)) {
      if (/\.(js|mjs|ts|vue)$/.test(f)) parts.push(stripComments(readFileSync(f, 'utf-8')));
    }
  }
  return parts.join('\n');
};

type ApiBinding = { helper: string; domain: string };

/**
 * 从岛的 api.js 解析 helper → 宿主能力域映射。
 * 各岛统一写法：`export const oi = (op, payload) => db('order-insight', op, payload)`。
 * 有了这层映射，守卫就能按域分别校验，而不是把所有 op 名混在一起比对一个白名单。
 */
const apiBindings = (id: string): ApiBinding[] => {
  const candidates = [
    resolve(root, 'ui-plugins', id, 'dist/api.js'),
    resolve(root, 'ui-plugins', id, 'src/api.ts'),
  ];
  const file = candidates.find((f) => existsSync(f));
  if (!file) return [];
  const out: ApiBinding[] = [];
  for (const m of readFileSync(file, 'utf-8').matchAll(
    /export const (\w+)\s*=\s*\([^)]*\)\s*=>\s*db\('([^']+)'/g,
  )) {
    out.push({ helper: m[1], domain: m[2] });
  }
  return out;
};

/** 宿主 DB_OPS 中某个域登记的全部 op（权威来源：src/core/plugin/host.ts） */
const hostDomainOps = (domain: string): string[] => {
  const text = readFileSync(resolve(root, 'src/core/plugin/host.ts'), 'utf-8');
  const start = text.indexOf(`\n  '${domain}': {`);
  if (start === -1) return [];
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n  },\n');
  const block = end === -1 ? rest : rest.slice(0, end);
  return [...block.matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);
};

describe('UI 岛的 db 能力调用必须全部在 manifest 中声明', () => {
  it.each(islandIds())('%s：能力域与 op 均被 capabilities 覆盖', (id) => {
    const bindings = apiBindings(id);
    if (bindings.length === 0) return; // 不使用 db 域的岛跳过
    const dbCap = (readManifest(id).capabilities ?? []).find((c) => c.id === 'db');
    if (!dbCap) return;

    const declaredDomains = new Set(dbCap.domains ?? []);
    const declared = new Set(dbCap.actions ?? []);

    const distDir = resolve(root, 'ui-plugins', id, 'dist');
    const srcDir = resolve(root, 'ui-plugins', id, 'src');
    const dir = existsSync(distDir) ? distDir : srcDir;
    if (!existsSync(dir)) return;

    const usedDomains = new Set<string>();
    const usedOps = new Set<string>();
    for (const f of walk(dir)) {
      if (!/\.(js|mjs|ts|vue)$/.test(f)) continue;
      const text = readFileSync(f, 'utf-8');
      for (const { helper, domain } of bindings) {
        for (const m of text.matchAll(new RegExp(`\\b${helper}\\('([A-Za-z][A-Za-z0-9]*)'`, 'g'))) {
          usedDomains.add(domain);
          usedOps.add(m[1]);
        }
      }
    }

    expect([...usedDomains].filter((d) => !declaredDomains.has(d))).toEqual([]);
    expect([...usedOps].filter((op) => !declared.has(op))).toEqual([]);
  });
});

describe('UI 岛的 manifest.name 与目录名一致', () => {
  it.each(islandIds())('%s', (id) => {
    expect(readManifest(id).name).toBe(id);
  });
});

describe('order-insight 岛已对齐内建版能力（缺口不得再悄悄回退）', () => {
  // 背景（2026-09-21/22）：内建视图包下记后，岛一度仍缺 6 项内建能力，
  // 用户侧表现为「功能凭空消失」——而这些 op 在 manifest 里早已声明，只是岛源码从未调用，
  // 因此上面的「调用 ⊆ 声明」断言完全覆盖不到。这里补一条反向断言：必须被真实引用。

  const ISLAND = 'order-insight';
  const REQUIRE_OPS = [
    'orderGet', // 拿货单查看
    'orderUpdate', // 拿货单编辑
    'priceHistory', // 单价记忆回填
    'ignoreRemove', // 待拿货缺口「取消忽略」
    'shopAllocation', // 店铺分摊汇总
    'shopAllocationDetail', // 店铺分摊明细
    'styleAssign', // 数据纠正「款编码手工指派」
  ];
  // 宿主 ReconciliationRow（src/types.ts）的真实字段名。
  // 旧版岛按 payableCents / name 读取 —— 宿主并不存在这些键，表格恒显示 0/空且不报错。
  const RECON_FIELDS = ['purchaseCents', 'paidCents', 'refundCents', 'balanceCents', 'orderCount'];

  it.each(REQUIRE_OPS)('op %s 被岛源码真实调用', (op) => {
    const text = islandSource(ISLAND);
    expect(new RegExp(`\\b(oi|purchase)\\('${op}'`).test(text)).toBe(true);
  });

  it('对账表读取的是宿主真实字段名（防字段名错位导致的恒 0 展示）', () => {
    const text = islandSource(ISLAND);
    // 用词边界而非 includes：`purchaseCentsX` 这类错拼不应被当成命中
    expect(RECON_FIELDS.filter((f) => !new RegExp(`\\b${f}\\b`).test(text))).toEqual([]);
  });

  it('数据纠正页的 reclassify 调用必须同时带 fingerprint（缺则静默空操作）', () => {
    // 宿主分支条件：input.reclassify && input.fingerprint。
    // 只传 reclassify 不传指纹 = 不报错、不生效，界面还提示「已重新归类」。
    //
    // 注意：必须**先剥掉注释**再找调用点（islandSource 已统一剥注释）。该文件的头注释里也写着
    // `oi('update', { …, fingerprint, … })`，直接 indexOf 会命中注释 ——
    // 那样即使真实调用丢了参数，断言照样通过（等于没守）。
    const file = resolve(root, 'ui-plugins', ISLAND, 'dist/views/correction.js');
    const code = stripComments(readFileSync(file, 'utf-8'));
    const idx = code.indexOf("oi('update'");
    expect(idx).toBeGreaterThan(-1);
    const call = code.slice(idx, idx + 400); // 该调用点附近即其对象字面量
    expect(call).toContain('fingerprint');
    expect(call).toContain('reclassify');
  });
});

describe('excel-copy 岛已对齐内建版能力（下记后不得悄悄缩水）', () => {
  // 背景（2026-09-22）：excel-copy（TV模版）内建视图包下记后，功能由 ui-plugins/excel-copy 独家提供。
  // 该岛有两处**必须走宿主**的硬约束，且都属于"违反了也不报错、只是功能不对"的类型：
  //   ① Excel 解析：岛内不打包 xlsx（宿主已有解析器，重复引入会让两端口径漂移）；
  //   ② 规则求值：iframe 的 CSP 是 `script-src 'self'`，**没有 unsafe-eval**，
  //      jsExpression 规则用的是 new Function —— 岛内根本无法执行。
  // 因此下面既查"宿主域每个 op 都被用上"，也查"岛内不得自行 eval / 引 xlsx"。
  const ISLAND = 'excel-copy';

  it('宿主 excel-copy 域的每个 op 都被岛真实调用（"声明了却没用"就是能力缺口）', () => {
    const ops = hostDomainOps(ISLAND);
    expect(ops.length).toBeGreaterThan(0);
    const text = islandSource(ISLAND);
    expect(ops.filter((op) => !new RegExp(`\\bec\\('${op}'`).test(text))).toEqual([]);
  });

  it('岛内不得出现 eval / new Function（iframe CSP 禁 eval，规则求值必须在宿主）', () => {
    const text = islandSource(ISLAND);
    expect(/\bnew\s+Function\s*\(/.test(text)).toBe(false);
    expect(/(^|[^.\w])eval\s*\(/m.test(text)).toBe(false);
  });

  it('规则求值确实走宿主 applyRules', () => {
    expect(/\bec\('applyRules'/.test(islandSource(ISLAND))).toBe(true);
  });

  it('配置命名空间为 excel-copy（与内建 modules.excel-copy 同源 → 老配置自动继承）', () => {
    const bridge = readFileSync(resolve(root, 'ui-plugins', ISLAND, 'dist/bridge.js'), 'utf-8');
    expect(bridge).toMatch(/export const NS = 'excel-copy'/);
  });

  it('岛内不引入 xlsx/SheetJS（解析在宿主完成）', () => {
    const text = islandSource(ISLAND);
    expect(/from\s+['"](xlsx|sheetjs)['"]/i.test(text)).toBe(false);
    expect(/require\(\s*['"](xlsx|sheetjs)['"]\s*\)/i.test(text)).toBe(false);
  });

  it('模板保存必须连 name 一起落库（只写 content 会出现"名字回退、内容却是新的"半保存）', () => {
    const store = readFileSync(resolve(root, 'ui-plugins', ISLAND, 'dist/store.js'), 'utf-8');
    const m = store.match(/export async function saveTemplateToFile[\s\S]*?\n\}/);
    expect(m).toBeTruthy();
    expect(m![0]).toContain('name: tpl.name');
  });
});
