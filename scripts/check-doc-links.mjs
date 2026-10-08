#!/usr/bin/env node
/**
 * 文档引用校验（R4-7 的验收工具）
 *
 * 为什么需要它
 * ------------
 * 文档目录整理（docs/ 分层）与文件删除（如 R4-1 删 PROJECT_OVERVIEW.md）都会打断引用。
 * 这类损伤的症状是"读者点开一个不存在的文件"，不会抛错、不会被 lint / tsc 发现，
 * 只能靠扫描。本脚本让「全仓文档引用无悬空」这句话**可复现**，而不是一次性结论
 * （与 `check-ipc-contract.mjs` 之于 R2-4 同理）。
 *
 * 三类引用与判定规则
 * ------------------
 * ① Markdown 链接 `](target)` —— **必须存在**。这是读者真正点击的路径，悬空即硬错误。
 *    跳过 http/https/mailto/tel/data；以 `/` 开头按仓库根解析，否则按所在文件目录解析。
 *
 * ② 反引号里的「路径形态」token（含 `/` 且以已知扩展名结尾）—— 依次尝试四种基准：
 *    a. 仓库根相对    → `src/lib/excelParser.ts`
 *    b. 所在文件目录  → `docs/README.md` 里的 `archive/manual.md`
 *    c. `docs/` 相对  → 审查报告里的 `architecture/PLUGIN_ARCHITECTURE.md`
 *    d. 后缀匹配      → 仓库内存在任一文件以 `/<token>` 结尾
 *       d 是必要的：插件/UI 岛文档大量使用包内相对路径（如 `src/main.js`），
 *       它们在仓库根下当然不存在，但完全合法。没有这一层，扫描结果 95% 是噪音。
 *    四者皆不命中 → 查下方 `DELIBERATELY_MISSING` 豁免表；仍未命中 → 报错。
 *
 *    另：首段为 `node_modules` / `dist` / `release` / `out` 的 token 直接跳过 ——
 *    它们指向依赖与构建产物，**按设计不在仓库内**（UI 岛的 `dist/index.html` 即此类）。
 *
 * ③ 代码文件中的**文档引用**（仅匹配 `docs/**` 与根级 `*.md`）—— 删除一份文档会让
 *    代码注释里的引用悬空（审查报告 §5.5 记录过 6 处这类引用）。只查这一类，
 *    不查代码里的普通路径，避免误伤。
 *
 * ④ `docs/notes/` 结论层的**反向守卫** —— 方向与 ①–③ 相反：那三条查"引用指向的文件是否存在"，
 *    这条查"存在的笔记是否被人知道"。多 AI 工具交替开工时，结论只有落进仓库才带得走
 *    （见 `AGENTS.md` §0 跨工具协作契约）；而"写了但没人索引到"与"没写"等价，所以
 *    `docs/notes/*.md`（除 `README.md`）必须同时满足：
 *      a. 文件名为 `YYYY-MM-DD-<slug>.md`（按日期可排序）；
 *      b. 在 `AGENTS.md` / `CHANGELOG.md` / `docs/README.md` / `docs/notes/README.md`
 *         之一里被引用（出现文件名或 slug 即算）。
 *    零条目时打印"未验证任何内容"而非静默通过 —— 扫描型守卫必须自证非空转。
 *
 * 豁免表的边界（重要）
 * ------------------
 * `DELIBERATELY_MISSING` 只承接**文档正在陈述"该路径不存在"的句子**——例如
 * "`core/layout/ContentHeader.vue` 从未创建"、"均已删除"、"引用了从未存在的 X"。
 * 这类 token 指的就是不存在的东西，不是悬空。
 *
 * 判断标准只有一条：**把该 token 改成存在的路径，句子是否就不成立了？**
 *   · 是 → 属本表（句子在陈述缺失）
 *   · 否 → 不属本表，去改文档
 * 每项都必须写理由。不要把新出现的悬空项直接塞进来 —— 那是把校验器改瞎。
 *
 * 已知覆盖边界（有意为之，不是遗漏）
 * ---------------------------------
 * · **不含 `/` 的裸文件名不检查**（`meta.ts` / `store.ts` / `index.ts` …）。文档里这类
 *   写法绝大多数是"模式指代"而非具体路径，逐一检查会产生成百条噪音，把真信号淹掉。
 *   代价是：`唯一文件名` 类的错误（如引用了拼错的单文件名）本脚本抓不到。
 * · **不检查 URL 的可达性**（跳过 http/https）。外链失效属于另一类问题，需联网，不放进门禁。
 * · `docs/archive/` 整体跳过：归档文档内含失效引用属正常，不该继续维护。
 *
 * 用法：node scripts/check-doc-links.mjs   （或 npm run verify:docs）
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

/** 扫描时跳过的目录：产物、依赖、AI 工具本地数据、历史归档（归档内含失效引用属正常） */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'release',
  'market-out',
  '.git',
  '.workbuddy',
  '.codebuddy',
  'archive',
]);

/** ② 反引号 token 的形态：至少一段目录 + 以已知扩展名结尾 */
const PATH_TOKEN_RE =
  /`([A-Za-z0-9_.@-]+\/[A-Za-z0-9_./@-]*\.(?:md|json|ts|tsx|vue|yml|yaml|css|mjs|cjs|js|html))`/g;

/** ③ 代码文件里只认「文档引用」 */
const DOC_TOKEN_RE = /`((?:docs\/[A-Za-z0-9_./-]+\.md)|(?:AGENTS|README|CHANGELOG|CONTRIBUTING)\.md)`/g;

/** ① Markdown 链接 */
const MD_LINK_RE = /\]\(([^)#\s]+?)(?:#[^)]*)?\)/g;

/** 依赖 / 产物 / AI 工具私有数据：指向它们的 token 按设计不存在于仓库，直接跳过 */
const NON_REPO_HEADS = new Set([
  'node_modules',
  'dist',
  'release',
  'out',
  // AI 工具本机数据（见 AGENTS.md §0）：`git clone` 后本就不存在，
  // 引用它们的文档不算悬空 —— 与 node_modules 同理。
  '.workbuddy',
  '.codebuddy',
  '.qoder',
]);

/** ④ docs/notes 结论层：命名规范 + 必须被索引（反向守卫） */
const NOTES_DIR = join(DOCS, 'notes');
const NOTE_NAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const NOTE_INDEX_FILES = [
  join(ROOT, 'AGENTS.md'),
  join(ROOT, 'CHANGELOG.md'),
  join(DOCS, 'README.md'),
  join(NOTES_DIR, 'README.md'),
];

/**
 * 豁免表：文档**有意引用不存在的路径**之处（句子本身在陈述"它不存在"）。
 * 每项必写理由；理由要能回答"为什么改成存在的路径后句子就不成立了"。
 */
const DELIBERATELY_MISSING = new Map([
  [
    'src/modules/goods/flow.ts',
    '2026-10-08 撤掉「货与成本」的步骤条引导后，该纯函数**与其单测一并删除**；CHANGELOG / GOODS_WORKBENCH_PLAN / 那条引导笔记记录的是"当时新增了它"，改指现存文件则句子不成立',
  ],
  [
    'tests/goodsFlow.spec.ts',
    '同上（同次一起删的；笔记与计划里"9 条断言"记的是当时实跑结果）',
  ],
  [
    'src/stores/app.ts',
    '陈述"重构前是单体"，该文件已拆除；改指现存文件则句子不成立',
  ],
  [
    'stores/app.ts',
    '同上（REFACTOR_PLAN 记录改造前的全局 store，无 src/ 前缀的写法）',
  ],
  [
    'excel-copy/store.ts',
    'REFACTOR_PLAN 记录迁移映射"原 stores/app.ts → 目标位置"，描述的是搬移关系',
  ],
  [
    'src/lib/electronAPI.ts',
    '审查结论："文档引用了**从未存在**的 src/lib/electronAPI.ts"——是结论，不是引用',
  ],
  [
    'core/layout/ContentHeader.vue',
    '核验结论："**从未创建**（唯一未实现项）"——是结论，不是引用',
  ],
  [
    'seller-kit/config.json',
    '记录旧用户手册**错误的**数据位置说法（平铺 key），句子正是在指正它',
  ],
  [
    'extensions/ae-profit/src/components/OrderListPanel.vue',
    '该目录已随 R1-5 删除（迁至 ui-plugins/），报告记录的是旧路径',
  ],
  [
    'docs/architecture/PROJECT_OVERVIEW.md',
    'R4-1 已删除该文件；报告 §5.5 引用关系表为历史记录，行内已标注「已删除」',
  ],
  [
    'scripts/lib/module-roots.js',
    'R1-1 的**提议名**（原计划措辞），实际落地为 module-roots.cjs；同处已加复核修正说明',
  ],
  [
    'docs/features/__pp_probe.md',
    '《CHANGELOG》的**删除记录**：该 0 字节探针残留已被删（句子正在说"为何删它"）',
  ],
  [
    'ui-plugins/product-library/__pp_probe.md',
    '同上（同次清理里删掉的零字节探针残留）',
  ],
  [
    'ui-plugins/product-library/README.md',
    '该岛已整体下架（2026-10-01，见 `docs/features/PRODUCT_LIBRARY.md` §0-A）；CHANGELOG 与 §7.5 记录的是当时的发布流程，属历史记录',
  ],
  [
    'src/ProductLibraryView.vue',
    '同上：岛根 Vue 文件（无 `ui-plugins/` 前缀的写法）；§7.5 验收表记录的是当时实跑结果',
  ],
  [
    'scripts/product-library-ui-smoke.mjs',
    '该冒烟脚本随岛一起下线（断言已整组迁入 `scripts/goods-ui-smoke.mjs`）；§0-A 的下架清单正在陈述"它已下线"',
  ],
  [
    'scripts/debug-order-db.js',
    'C7 的**删除记录**：该一次性调试脚本已删（句子正在说"删了它"）；改指现存文件则句子不成立',
  ],
  [
    'ui-plugins/ae-profit/src/components/CostRatesPanel.vue',
    'UX 审查（取数时点 2026-09-30）记录的是**当时**该面板的文案问题；同日 C9 收编把「成本与汇率」并入宿主',
  ],
  [
    'ui-plugins/order-insight/dist/views/picking.js',
    'C2 的**删除记录**：岛内「拣货」页签随"入口唯一"撤回（发布前，1.5.0 未发布）；句子正在说"删了它"',
  ],
  [
    'tests/orderInsightPicking.spec.ts',
    '同上（C2）：该接线守卫随页签一起删；多处文档记录的是"曾经有、现已删"',
  ],
  [
    'src/lib/productWeight.ts',
    '**删除记录**（2026-10-01 领域裁定）：克重是 SKU 属性而非商品ID 属性，`pl_item_weights` + 该解析文件整条删除、改挂 `pl_variants.weight_g`。CHANGELOG 与运费岛计划里的引用是"当时做过、现已删"，三处均已就地标注 ⚠️；改指现存文件则句子不成立',
  ],
  [
    'scripts/order-insight-picking-ui-smoke.mjs',
    '同上（C2）：该假桥冒烟随页签一起删；现役样板见 `scripts/shipping-rate-ui-smoke.mjs`',
  ],
  // —— 下面这组是 C3（删 `extensions/` 留档包，2026-09-30）的**历史记录**：
  // 句子都出自"当时"的评审/计划（或 CHANGELOG 的删除记录），说的是"曾经有、现已删"，不是悬空引用。
  [
    'extensions/order-insight/src/store.ts',
    'C3 的**删除记录**：`extensions/` 留档源码已于 2026-09-30 删除（AGENTS §1.9 / 计划 / CHANGELOG 多处引用的是当时路径）',
  ],
  [
    'extensions/order-insight/src/stock-in/store.ts',
    '同上（C3）：留档包的拿货对账 store，已随目录删除',
  ],
  [
    'extensions/excel-copy/src/store.ts',
    '同上（C3）：留档包的扁平存储 store（`AppState` 的唯一引用方），已随目录删除',
  ],
  [
    'extensions/excel-copy/src/settings.ts',
    '同上（C3）：留档包的设置贡献入口，其分类早已随下记消失、目录亦已删除',
  ],
  [
    'extensions/order-insight/src/components/ProductLibraryView.vue',
    '同上（C3）：留档包里的产品库视图（HOST_REVIEW 记录的是旧路径），已随目录删除',
  ],
  [
    'stock-in/store.ts',
    '同上（C3）的**后缀写法**：PLUGIN_TRIAGE_PLAN 描述当时留档布局时用的相对路径；该文件已随目录删除',
  ],
  // —— 下面这组是「订单归类」岛整体下架（2026-10-05）的历史记录：引用都出自 CHANGELOG 的
  // **当时条目**与一份**当时的评审快照**，句子正在说"当时改的是它 / 当时它长这样"，不是悬空引用。
  [
    'ui-plugins/order-insight/manifest.json',
    'CHANGELOG 的历史条目（1.4.0 升版当时改的就是这个文件）；该岛已于 2026-10-05 整体下架，见 docs/notes/2026-10-01-ui-island-retirement.md §6',
  ],
  [
    'tests/orderInsightShopAtImport.spec.ts',
    'CHANGELOG 记录的是"1.4.0 当时新增了这个接线守卫"；该 spec 已随岛下架删除（守卫的坑已由内建页的 today:ui 冒烟承接）',
  ],
  [
    'ui-plugins/order-insight/dist/splitter.js',
    'CHANGELOG 的分割条修复记录（当时是双份拷贝同改：留档源码 + 岛产物）；该岛已整体下架',
  ],
  [
    'ui-plugins/order-insight/dist/views/stockin.js',
    'docs/reviews 的 UI 评审快照（写于 2026-09-22，记的是**当时**该岛的命中点）；岛已下架，改成现存路径则句子不成立',
  ],
  [
    'scripts/order-insight-settings-ui-smoke.mjs',
    'CHANGELOG 的删除记录 + 下架笔记 §6.2 说的正是"它**从未被 git 跟踪**、也已随岛删除"；改指现存文件则句子不成立',
  ],
]);

// ---------------------------------------------------------------- 文件索引

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // 点开头的一律跳过（.git/.workbuddy/.codebuddy 等），仅保留 .github
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (!entry.name.startsWith('.')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const allFiles = walk(ROOT);
const relOf = (f) => relative(ROOT, f).split(sep).join('/');

/** 后缀索引：`src/main.js` → 仓库内是否存在以该串结尾的路径 */
const suffixSet = new Set(
  allFiles.flatMap((f) => {
    const parts = relOf(f).split('/');
    return parts.map((_, i) => parts.slice(i).join('/'));
  }),
);

const mdFiles = allFiles.filter((f) => f.endsWith('.md'));
const codeFiles = allFiles.filter((f) => /\.(ts|tsx|vue|js|cjs|mjs)$/.test(f));

// ---------------------------------------------------------------- 校验

const errors = [];
const stats = {
  links: 0,
  tokens: 0,
  codeRefs: 0,
  baseResolved: 0,
  suffixResolved: 0,
  exempted: 0,
  notes: 0,
  notesIndexed: 0,
};
const exemptHits = new Map();

/** 依次尝试四种基准，返回命中的基准名（未命中返回 null） */
function resolveToken(file, token) {
  if (existsSync(resolve(ROOT, token))) return 'root';
  if (existsSync(resolve(dirname(file), token))) return 'sibling';
  if (existsSync(resolve(DOCS, token))) return 'docs';
  if (suffixSet.has(token)) return 'suffix';
  if (suffixSet.has('docs/' + token)) return 'docs-suffix';
  return null;
}

// ① + ② Markdown
for (const file of mdFiles) {
  const text = readFileSync(file, 'utf8');

  for (const m of text.matchAll(MD_LINK_RE)) {
    const target = m[1];
    if (/^(https?:|mailto:|tel:|data:)/.test(target)) continue;
    stats.links++;
    const abs = target.startsWith('/') ? join(ROOT, target) : resolve(dirname(file), target);
    if (!existsSync(abs)) {
      errors.push({ file: relOf(file), target, kind: 'Markdown 链接不存在' });
    }
  }

  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    const token = m[1].replace(/^\.\//, '');
    stats.tokens++;
    if (NON_REPO_HEADS.has(token.split('/')[0])) continue;

    const how = resolveToken(file, token);
    if (how === 'root' || how === 'sibling' || how === 'docs') {
      stats.baseResolved++;
      continue;
    }
    if (how === 'suffix' || how === 'docs-suffix') {
      stats.suffixResolved++;
      continue;
    }

    if (DELIBERATELY_MISSING.has(token)) {
      stats.exempted++;
      exemptHits.set(token, (exemptHits.get(token) ?? 0) + 1);
      continue;
    }

    errors.push({
      file: relOf(file),
      target: token,
      kind: '路径不存在（根相对 / 同级 / docs 相对 / 后缀 四者均未命中）',
    });
  }
}

// ③ 代码文件中的文档引用
for (const file of codeFiles) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(DOC_TOKEN_RE)) {
    const token = m[1];
    stats.codeRefs++;
    if (!existsSync(resolve(ROOT, token))) {
      errors.push({ file: relOf(file), target: token, kind: '代码注释引用的文档不存在' });
    }
  }
}

// ④ docs/notes 结论层：命名规范 + 必须被索引（反向守卫）
if (existsSync(NOTES_DIR)) {
  const indexText = NOTE_INDEX_FILES.filter((f) => existsSync(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const noteFiles = readdirSync(NOTES_DIR)
    .filter((n) => n.endsWith('.md') && n !== 'README.md')
    .sort();

  for (const name of noteFiles) {
    stats.notes++;
    if (!NOTE_NAME_RE.test(name)) {
      errors.push({
        file: `docs/notes/${name}`,
        target: name,
        kind: '笔记命名不合规（应为 YYYY-MM-DD-<slug>.md）',
      });
      continue;
    }
    const slug = name.slice(0, -'.md'.length);
    if (indexText.includes(name) || indexText.includes(slug)) {
      stats.notesIndexed++;
      continue;
    }
    errors.push({
      file: `docs/notes/${name}`,
      target: name,
      kind: '笔记未被索引（在 AGENTS.md / CHANGELOG.md / docs/README.md / docs/notes/README.md 中均未出现）',
    });
  }
}

// ---------------------------------------------------------------- 输出

console.log('文档引用校验（scripts/check-doc-links.mjs）');
console.log(`  扫描：${mdFiles.length} 个 Markdown、${codeFiles.length} 个代码文件`);
console.log(
  `  引用：Markdown 链接 ${stats.links} 条、反引号路径 ${stats.tokens} 条、代码内文档引用 ${stats.codeRefs} 条`,
);
console.log(
  `  通过：路径直解 ${stats.baseResolved} 条、后缀/包内相对 ${stats.suffixResolved} 条、` +
    `有意缺失豁免 ${stats.exempted} 条`,
);
console.log(
  stats.notes === 0
    ? '  ④ docs/notes 结论层：0 条笔记 —— ⚠️ 本项未验证任何内容（不等于"通过"）'
    : `  ④ docs/notes 结论层：${stats.notes} 条笔记，已登记 ${stats.notesIndexed} 条`,
);
if (exemptHits.size) {
  console.log('\n  有意缺失的引用（豁免，逐项核对理由）：');
  for (const [token, n] of [...exemptHits].sort()) {
    console.log(`    · ${token}（${n} 次）—— ${DELIBERATELY_MISSING.get(token)}`);
  }
}

if (errors.length === 0) {
  console.log('\n✅ 无悬空引用');
  process.exit(0);
}

console.log(`\n❌ 发现 ${errors.length} 条悬空引用：\n`);
for (const e of errors) {
  console.log(`  ${e.file}\n    → ${e.target}\n      ${e.kind}`);
}
console.log('\n修法：① 改文档指向正确路径（首选）；② 若句子本就在陈述"它不存在"，');
console.log('      加入脚本头部 DELIBERATELY_MISSING 并写明理由；');
console.log('      ③ 笔记类（docs/notes/…）：改名到 YYYY-MM-DD-<slug>.md，');
console.log('        并在 docs/notes/README.md 的索引表登记一行。');
process.exit(1);
