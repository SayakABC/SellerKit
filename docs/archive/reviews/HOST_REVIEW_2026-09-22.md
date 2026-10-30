# 宿主代码复查报告（2026-09-22 · 下记之后）

> 定位：**增量复查**供应商，不重复 `CODE_REVIEW_REPORT.md`（那是全量基线审查）。
> 本次聚焦「内建业务模块全部下记为市场 UI 岛」之后，**宿主侧**还剩什么问题。
> 范围：`vite.config.ts` / `modules.config.json` / `scripts/**` / `electron/**` / `src/core/plugin/**` /
> `src/core/components/**` / `tests/**` / `AGENTS.md` 与 `docs/**` 的一致性。
> 不含：`ui-plugins/**` 岛内代码（非宿主；已有 `pluginTriage.spec.ts` + 无头冒烟两层守卫）。

---

## 0. 摘要

**六道门禁实测全绿**（见 §3），但它们校验的是「契约一致」，**看不见本报告的 10 项问题**。

| 编号 | 级别 | 一句话 |
|---|---|---|
| **H-01** | 🔴 P1 | `npm run dist:select` 把已下记的 `excel-copy` / `order-insight` 当**可打包模块**列出；勾选即占用岛 id（违反 AGENTS 红线 23），从市场装的同名岛将永远没有侧栏入口 |
| **H-02** | 🔴 P1 | `db` 域 `excel-copy` 的 `readTextFile` / `saveTemplateFile` / `checkFileExists` 接受**任意绝对路径**；主进程 `read-file` / `save-template` 无路径约束、无大小上限 → 任何声明该域的岛获得**全盘读 + 任意文件覆写** |
| **H-03** | 🔴 P1 | **HEAD 停在 2026-09-16，工作区领先 87 项未提交改动**；`AGENTS.md`、`docs/baseline|plans|reviews/`、`ui-plugins/excel-copy/`（整岛）、4 个测试文件**全部是未跟踪状态** → 一次 `git clean -fd` 即不可逆丢失；且无法回滚 / bisect。补救计划 R0-0 早已点出，至今未执行 |
| **H-04** | 🔴 P1 | **（复查中追加）** `.gitignore` 的 `dist/` 通配吞掉了 `excel-copy` / `order-insight` 两个岛的**全部源码**——这两个岛无构建步骤，源码就手写在 `dist/` 下。仓库里长期存着「`manifest.entry` 指向不存在文件」的坏岛（`order-insight` 1.2.0 已发布仍如此）。**且它会让"序 0 检查点"本身变成陷阱**：`git add -A` 只收录 `manifest.json` + `README.md` |
| **M-01** | 🟠 P2 | `will-navigate` 只拦 `.xlsx/.xls`；无全局 `dragover/drop` 拦截、无 `setWindowOpenHandler` → 生产环境把任意本地 HTML 拖进窗口，该文档在宿主窗口内加载且 **preload 仍生效**（`window.electronAPI` 可用） |
| **M-02** | 🟠 P2 | 桥层无载荷体积上限，而 `applyRules` 单次可收 50000×256×20000 字符 → 可撑爆渲染进程 |
| **M-03** | 🟠 P2 | `AGENTS.md` 多处陈述已被下记推翻，且 §5 仍在示范 `MODULE_IDS=excel-copy,quick-note`（**正是 H-01 的违规操作**） |
| **M-04** | 🟠 P2 | **（复查中追加）** `excel-copy` / `order-insight` 的设置自带在**岛内视图**里，未声明 `manifest.settings` → 不进「设置」模态的分类导航，与 AGENTS §1.5「岛内不再重复实现设置页、宿主是唯一入口」不一致（`shop-accounts` 走了正路） |
| **L-01** | 🟡 P3 | 「留档」的 `extensions/order-insight` 被 `tests/colorSwatch.spec.ts` 直接 import → 按计划 `git rm -r` 会打挂门禁；该纯函数按 §1.2 本应在 `src/lib/` |
| **L-02** | 🟡 P3 | `PLUGIN_DEVELOPMENT.md` 称 `secrets` 需声明 `domains`，实际 `gatedHost.secrets.status()` 不传 domain → 该声明**无任何作用**（文档与实现不一致） |
| **L-03** | 🟡 P3 | `engines.sellerkit` 只校验"是非空字符串"，从不做范围比对 → 兼容性声明是**装饰性的** |
| **L-04** | 🟡 P3 | `CHANGELOG.md` 未记录三轮下记与 UI 岛体系；4 处注释/文档滞后于事实（`LICENSE` 缺失属**有意挂起**，见勘误，不计入） |

---

## 1. 发现项详述

### H-01 🔴 P1 · `dist:select` 主动诱导违反红线 23（已实测复现）

**位置**：`scripts/select-build.js:31-33`（`scanModules()` → `enumerateModules`）、`scripts/lib/module-roots.cjs:66-71`

`enumerateModules()` 的判定规则是「目录下存在 `meta.ts`」。下记时**保留了源码留档**，于是：

```
$ node scripts/select-build.js --list
可打包模块:
  excel-copy  (TV模版)  [插件包]      ← 已下记为市场岛，不该出现在这里
  order-insight  (订单归类)  [插件包]  ← 同上
  quick-note  (便签)  [内建]
忽略 2 个目录（无 meta.ts 入口，不参与打包裁剪）: _template, sk-hello
```

选中后 `MODULE_IDS=excel-copy` 的**实际构建结果**（实测）：

```
$ MODULE_IDS=excel-copy npx vite build
✓ built in 588ms

$ head -3 src/registry.generated.ts
import * as excelcopy from '../extensions/excel-copy/src/meta';
export const enabledModuleMetas = [excelcopy.meta];
export const moduleViewLoaders = Record<string, ...> = { 'excel-copy': () => import('...'),};
```

> **勘误（2026-09-22，修复时实测发现）**：本节初稿还写了「并顺带把 492 KB 的 `xlsx` 打回包」。
> 修复过程中对比构建产物后确认**该归因不成立**：`xlsx`（492 KB）在**默认预设下同样在包里**
> （`modules=[quick-note]`、registry 无 excel-copy 时依然产出 `xlsx-*.js`），因为宿主必须为
> 岛的 `db[excel-copy]` 域提供 Excel 解析（CSP 禁 `unsafe-eval`，解析只能留在宿主）。
> 勾选 excel-copy 的影响只是"该模块自身进 registry 并占 id"，与 xlsx 体积无关。
>
> **勘误之勘误（2026-09-22 二次实测，L-05 关闭）**：上一段末句称该 chunk 是"入口的静态依赖
> （启动即加载）"——**这一句同样不成立**。实测（重新 `npm run build` 后核对产物）：
> `dist/renderer/index.html` 只加载入口 `index-*.js`（242 KB）与 CSS，**没有任何 modulepreload**；
> 入口 chunk 对 xlsx 的引用形态是 `await mf(() => import('./xlsx-*.js'))`，即**动态导入**。
> 宿主侧本就是 `await import('@/core/services/excel')`（`host.ts` 三处），
> 故 xlsx 只在岛真的调用 `db['excel-copy'].parseExcel*` 时才被拉取，**首屏不加载**。
> 结论：**L-05「改懒加载」无需执行，已关闭**；现状即最优。
> 判据（供后续同类判断复用）：**产物里存在某 chunk ≠ 它会被首屏加载**——
> 必须看 `index.html` 的 `modulepreload` 与入口 chunk 对该 chunk 的引用形态（静态 `from` 还是 `import()`）。

**后果链**：注册表收录 `excel-copy` → `managerDiscover.discover()` 先占 id →
`registerUiIsland()` 见 `records.has(id)` **静默 return** → 从市场装的 excel-copy 岛**永远没有侧栏入口**
（`managerDiscover.ts:109-119` 的 warn 只在 console）。这正是 AGENTS 红线 23 要防的场景，而**脚本主动把它列了出来**。

**为什么守卫没兜住**：`tests/pluginTriage.spec.ts:67-73` 确实会检查 `registry.generated.ts` 中不含岛 id，
但它只在 `npm test` 时执行；而 `dist:select` 是「勾选 → 构建 → 问你要不要出安装包」一条龙，**顺序上守不住**。

**成因注记**：R1-1 为了让选择器不再漏模块（原 C-20 只扫出 1 个），把扫描面从 `src/modules` 扩到了双根。
下记把「留档目录」引进来之后，这个修复**反转成了新的风险源**。

**建议修法**（三者取其一，推荐①）：
1. `select-build.js` 里过滤掉「同名 `ui-plugins/<id>` 已存在」的候选，并打印一行提示；
2. `modules.config.json` 增一个显式的 `archived: ['excel-copy','order-insight']` 清单，`enumerateModules` 跳过；
3. 把留档源码移出 `extensions/`（如 `docs/archive/legacy/`），从根上不参与枚举 —— 需连带改 `tsconfig.json` 的 `include` 与 `tests/colorSwatch.spec.ts`（见 L-01）。

---

### H-02 🔴 P1 · `db[excel-copy]` 实际是「全盘读 + 任意文件覆写」

**位置**：`src/core/plugin/host.ts:137-183`（域定义）→ `electron/main.ts:237-254`（`read-file`）、`265-272`（`save-template`）

```ts
// host.ts —— 4 个 op 直接把载荷里的字符串当路径用，无任何约束
parseExcel:      (p) => ipc.importExcelByPath(String(p?.filePath ?? '')),
readTextFile:    (p) => unwrap(ipc.readFile(String(p?.filePath ?? ''))),
checkFileExists: (p) => unwrap(ipc.checkFileExists(String(p?.filePath ?? ''))),
saveTemplateFile:(p) => unwrap(ipc.saveTemplate(String(p?.filePath ?? ''), String(p?.content ?? ''))),
```

```js
// main.ts —— 无条件读 / 无条件写
ipcMain.handle('read-file', (_e, filePath) => { ... fs.readFileSync(filePath) ... });
ipcMain.handle('save-template', (_e, filePath, content) => { fs.writeFileSync(filePath, content, 'utf-8'); });
```

**可达性已核实**：UI 岛确实拿到的是**过权限门**的能力面（`managerDiscover.ts:125` `createGatedHostApi(...)`），
权限门也确实是 `domain + action` 双重校验（`gatedHost.ts:87-92` 传 `action: op`；`security.ts:113-123` 查 `domains`）。
但门槛只有一处：**manifest 里声明 `db` 域 + 这 4 个 op 名**。声明之后：

- 读：`db.call('excel-copy','readTextFile',{filePath:'<任意绝对路径>'})` → 整个文件内容回给岛；
- 写：`db.call('excel-copy','saveTemplateFile',{filePath:'<任意绝对路径>',content:'...'})` → 覆写任意可写文件（**无大小上限**）；
- 探：`checkFileExists` → 任意路径存在性探测；
- 另：`parseExcel` 复用同一个 `read-file`，所以它也不是"只能读 Excel"。

**风险被低估的两点**：
1. **能力命名与实际权力不符**。`readTextFile` / `saveTemplateFile` 的语义读起来像"读/写模板文件"，
   实际是"读/写这台机器上的任何文件"。而权限门的 `db` 域**只到域级**（`domains:['excel-copy']`），
   op 名白名单挡不住路径。
2. **安装期的同意是不知情的**。`PluginCenter.vue:88-97` 只把 capability **id 标签**（`db`、`clipboard`…）显示成
   chip，不展开 domain/action。用户看到"db"无法推断出"可覆写我的任意文件"。

**同源问题（既存，非本轮引入）——经修复时逐条核对后收窄**：

| op | 初稿判断 | 实测 | 处置 |
|---|---|---|---|
| `readImage` / `imageThumb` / `imageThumbBatch` | 「也是任意路径读取」 | ❌ **判断有误**：`electron/order-handlers.ts` 的 `order-read-image` 已做三段校验（`realpathSync` → 父目录名必须为 `order-images` → 扩展名白名单），缩略图走同一 `resolveThumbPath` | 无需改动 |
| `readLocalImage` | 「任意路径读取」 | ✅ 属实，**且比初稿写的更糟**：路径不是"用户在导入对话框选的"，而是**用户导入的 Excel 单元格内容**（旧版 `store.readImageForImport(raw)` 的 `raw` → `orderReadLocalImage(raw)`）。即一份表格里的文本就能驱动宿主读本机任意图片并以 base64 回吐 | 已用同一白名单收紧（见 §5） |

> 该文件的注释原本写着「该文件是用户在导入对话框主动选择的本地产品图，属明确授权的读取范围」——
> 与实现不符，已一并改写。

**这是否有正当需求？** 查调用方：`saveTemplate` / `readFile` 在 `src/` 里**只有 `host.ts` 这一个使用点**，
即"仅供插件访问"。不存在"内建代码本来就需要任意路径写"的理由，因此收紧成本很低。

**建议修法**：
- **最小**：`saveTemplateFile` 只允许写「模板目录」（`filePath` 的 `dirname` 必须等于 `getDefaultTemplatePath()` 的目录，或用户在本次会话里经 `dialog.openFile({kind:'template'})` 真实选过的路径白名单）；
  `readTextFile` 同法限制到同一白名单；`checkFileExists` 至少限制到白名单内。
- **根治**：`dialog.openFile` 返回值改为「不透明句柄」（主进程侧维护 path↔handle 映射），后续读/写只认句柄，路径永不经过插件。
- **配套**：`PluginCenter` 展示 capability 明细（`domains` / `actions` 展开），让同意可判断。

---

### H-03 🔴 P1 · 版本库停在 09-16，一周的工作与基线文档全部未提交

**实测**：

```
$ git log -1 --format=%ci          → 2026-09-16 14:35:06 +0800
$ git status --porcelain | wc -l   → 87
   32 M   9 R   7 RM   4 D   5 A   8 AM   22 ??
$ git status --porcelain | grep '^??'
?? AGENTS.md                      ← 项目基线文档（AI 与开发者的必读规则）从未入库
?? CHANGELOG.md
?? CONTRIBUTING.md
?? docs/architecture/PLUGIN_ARCHITECTURE.md
?? docs/baseline/  ?? docs/plans/  ?? docs/reviews/     ← 三个文档目录整体未跟踪
?? electron/company-db.ts  ?? electron/company-handlers.ts
?? scripts/check-doc-links.mjs
?? src/core/components/IslandSettingsPanel.vue
?? tests/pluginManifest.spec.ts  ?? tests/pluginSettingsIsland.spec.ts
?? tests/pluginTriage.spec.ts  ?? tests/uiIslandThemeTokens.spec.ts   ← 13 个测试文件里 4 个未跟踪
?? ui-plugins/excel-copy/    ← 本轮刚交付的整个岛
```

**为什么是 P1**：

1. **不可逆丢失面很大**。以上任意一条 `git clean -fdx`（或在 IDE 里"丢弃未跟踪文件"）都会删掉
   `AGENTS.md`、三个文档目录、整个 excel-copy 岛、以及**恰好是守卫网的那 4 个测试文件** ——
   而 `AGENTS.md` 是"修改本项目必须遵循"的基线，丢了它连规则本身都没了。
2. **没有回滚能力**。CLAUDE/CHANGELOG 里 `v1.0.0 / v1.0.1 / v1.0.2 / v1.0.4` 四个 tag 指向**同一个 commit**，
   而工作区又领先 HEAD 一周 —— 既不能 `git diff` 看"这次改了什么"，也不能 `git bisect` 定位回归。
   本报告的所有取证（如 H-01 的构建复现）都只能靠读当前磁盘状态，**没有历史可比对**。
3. **`README.md` / `docs/README.md` / `PLUGIN_DEVELOPMENT.md` 等 32 个文件是 M**，
   意味着"仓库里能看到的内容"与"实际在跑的内容"已经分叉。

**这不是新问题，而是没做完**：`docs/plans/REMEDIATION_PLAN.md:64`（R0-0）写的是
「评审并提交当前未提交改动（含 `electron/mail-*.ts`、`electron/shop-accounts-*.ts`、`extensions/shop-accounts/`、
`extensions/ae-profit/` 改动等）；打 tag `v1.0.4` 指向该 commit，作为整改起点」。

实际状态：**tag 那半步做了**（`remediation-baseline -> 744fbe3`，2026-09-16 11:16，是 HEAD 的祖先），
**"提交当前未提交改动"那半步没做** —— 于是在这个基线之上又叠了一周、87 个文件，仍然全部悬在工作区里。
Phase 1–3 的每一轮整改都是在**没有检查点**的工作区上继续叠加的。

**建议**：在动本报告任何一项修复**之前**先做这一步（否则修复本身也没有存档）：
```bash
git add -A && git commit -m "chore: 检查点——三轮下记（shop-accounts/order-insight/excel-copy）+ UI 岛体系 + 工程化整改"
git tag -a v1.1.0 -m "新增 UI 岛体系；全部业务模块下记为市场岛"
```

> **执行记录（2026-09-22）**：已完成，但**先修掉了 H-04 才提交**（否则 `git add -A` 会提交出一个
> "有 manifest、无源码"的坏仓库）；tag 也未按此处提议打 `v1.1.0`，理由见 §5 的两点偏差说明。

---

### H-04 🔴 P1 · `.gitignore` 的 `dist/` 通配吞掉了两个岛的**全部源码**

**位置**：`.gitignore:3`（`dist/`，无锚点 → 匹配任意层级的 `dist/` 目录）

**形态**：`ui-plugins/` 下两种岛并存，而 `.gitignore` 只认名字：

| 岛 | `package.json` | `src/` | `dist/` 是什么 | 提交什么才对 |
|---|---|---|---|---|
| `ae-profit` / `shop-accounts` / `sk-ui-starter`（**后者 2026-09-24 已删除**，见 `docs/plans/PLUGIN_TRIAGE_PLAN.md` §7-4） | 有 | 有 | **构建产物**（Vite 现场构建） | `src/`（`dist/` 忽略正确） |
| `excel-copy` / `order-insight` | **无** | **无** | **手写 ESM 源码本身** | `dist/`（忽略即丢源码） |

后两者的 `manifest.entry` 都指向 `./dist/index.html` —— 而 `.gitignore` 把它们整目录排除了。

**实测**：

```
$ git check-ignore -v ui-plugins/excel-copy/dist/main.js
.gitignore:3:dist/     ui-plugins/excel-copy/dist/main.js

$ git add -A --dry-run ui-plugins/excel-copy/
add 'ui-plugins/excel-copy/README.md'
add 'ui-plugins/excel-copy/manifest.json'      ← 2,167 行源码一条都没进

$ git ls-files ui-plugins/order-insight | wc -l
2                                              ← 只有 README.md 与 manifest.json
```

**影响**：

1. **已发布的岛在仓库里是坏的**。`order-insight` 1.2.0 已经作为 zip 发布出去，但仓库从来没有它的源码
   —— 克隆 / 回滚 / 换机后拿到的是一个 `entry` 指向不存在文件的岛（3,135 行缺失）。
2. **检查点本身会被污染**。H-03 的处置动作是 `git add -A && git commit`；若不先修本项，
   这一步会**立刻**产出一个"看着有存档、实际无源码"的提交 —— 比不提交更隐蔽。
3. **不会报错**。本地磁盘上文件都在（构建与冒烟都正常），只有从仓库取代码时才暴露；
   而 README 里"`dist/` 即源码"的说明在忽略规则面前不起作用。

**建议修法**（已在 §5 落地）：在 `.gitignore` 里为这两个岛加**定向例外**，并加一条守卫
（岛的"源码真相"必须未被忽略）钉住 —— 守卫见 `tests/pluginTriage.spec.ts` 的
「岛的运行入口必须真实入库」分组。

> **守卫实现的一个坑（实测）**：`git check-ignore` 默认会先查索引，而**已被跟踪的路径永远不报"被忽略"**
> —— 用它写断言时，回归（去掉例外）后测试**依然全绿**。必须加 `--no-index` 才是纯规则判定。

---

### M-01 🟠 P2 · 导航/拖放防护不完整，且漏掉的是"保留 preload"的那条路径

**位置**：`electron/main.ts:157-164`

```js
mainWindow.webContents.on('will-navigate', (e) => {
  if (e.url.startsWith('file://')) {
    const filePath = decodeURIComponent(e.url.replace('file://', ''));
    if (filePath.endsWith('.xlsx') || filePath.endsWith('.xls')) e.preventDefault();
  }
});
```

三个缺口：

1. **只拦了两个扩展名**。拖一个 `.html` / `.svg` / `.pdf` 进窗口，主窗口**照样导航过去**。
2. **没有全局 `dragover`/`drop` 拦截**。实测：`src/core/AppShell.vue` 只注册了 `keydown` / `open-settings` /
   `switch-module`（`:503-506`），全仓 `preventDefault` 的 7 处里没有一处是 document 级拖放
   （`QuickNoteView.vue:96` 是便签自己的输入区）。
3. **没有 `setWindowOpenHandler`**。全仓 grep 无命中 → `window.open()` / `target="_blank"` 会真的开一个新窗口。

**为什么缺口 1/2 是 P2 而不是 P3**：被导航到的文档**仍然挂着 preload**（preload 绑定在 webContents 上，不随 URL 变化）。
生产环境里主窗口本身就是 `file://` 源，导航到另一个 `file://` 是被允许的 → 那个被拖进来的 HTML 页面**直接拥有
`window.electronAPI`**，即 `read-file` / `save-template` / 全部 141 个暴露键。对"文件来自第三方（供应商 Excel、别人发的模板）"
就是常态的业务来说，这条路径足够现实。它和 H-02 是同一类后果（任意文件读写），只是入口不同。

**建议修法**（已在 §5 落地，实施时比初稿更严一点）：

```js
// main.ts —— 白名单按集合比较，而不是前缀 startsWith（避免 http://localhost:5173.evil.com 这类绕过）
const ownUrls = new Set([DEV_SERVER_URL, pathToFileURL(indexHtmlPath).toString()]);
mainWindow.webContents.on('will-navigate', (e, url) => {
  if (ownUrls.has(String(url).split(/[?#]/)[0])) return;   // 同文档 hash/query 变化不算导航
  e.preventDefault();
});
mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
```

```js
// AppShell.vue —— 渲染层第二道；**只拦文件拖放**，否则拖文本进输入框的默认插入行为会被一起干掉
document.addEventListener('dragover', onGlobalDragOver, true);   // 捕获阶段：子视图忘了 preventDefault 也拦得住
document.addEventListener('drop', onGlobalDrop, true);
```
（岛内的拖拽导入在自己的 iframe 里 `preventDefault`，是另一个文档，不受影响。）

---

### M-02 🟠 P2 · 桥层无载荷上限，`applyRules` 的规模约束组合可撑爆内存

**位置**：`src/core/plugin/uiBridgeHost.ts:266-299`（`handleCall` 只校验 arity，不校验体积）
配合 `src/core/plugin/host.ts:43-47`：

```ts
const EC_MAX_RECORDS = 50000;   // 记录数
const EC_MAX_FIELDS  = 256;     // 每条字段数
const EC_MAX_STR     = 20000;   // 每个值字符数
```

单次 `applyRules` 的**理论上限** ≈ 50000 × 256 × 20000 字符——这显然不是"约束"，只是"防止无限"。
只要岛（或岛的 bug，例如把整个记录集重复拼进去）发出这种量级的 `postMessage`，
结构化克隆 + `sanitizeRecords` 的逐字段 `slice` 就能把渲染进程钉死或 OOM，**没有任何一道防线会先拦下它**。
宿主其余 IPC 是有体积纪律的（`ipc-handlers.ts` 对 HTTP 明确 `body≤10MB`、`响应≤10MB`），桥这条路径**漏了这一层**。

**建议修法**：
- 在 `uiBridgeHost.handleCall` 入口加一条总字节预算（例如序列化前先估算，或用 `structuredClone` 前的 length 检查），超限直接回 `{ok:false,error:'payload too large'}`；
- 或把 `EC_*` 上限收到与真实业务同量级（记录数 × 字段数 × 单值长度 ≈ 十 MB 级），并在超限时**报错**而不是静默截断（现在的 `slice` 是静默截断，见下）。

> 顺带一提：`sanitizeRules` / `sanitizeRecords` 的 `slice()` 是**静默截断**——超限时不报错、直接丢尾部，
> 于是"少了几条记录"会表现为"数据莫名丢失"而不是"被拒绝"。按 AGENTS §2.3「禁止吞错误」的精神，
> 这里更适合"超限即拒绝 + 明确报错"。

---

### M-03 🟠 P2 · `AGENTS.md` 已被下记推翻，且仍在外示范违规命令

| 位置 | 现在的陈述 | 事实 |
|---|---|---|
| `AGENTS.md:110`（§1.5） | 「当前分类：`general`（通用）/ `excel`（TV模版，含二级 Tab：模板配置 / 字段规则 / 显示列）」 | `excel` 分类随 `extensions/excel-copy/src/settings.ts` 一起消失；现为 `general` / `plugins` + 各岛的 `<pluginId>:settings`（`SettingsModal.vue:235`） |
| `AGENTS.md:172`（§1.8） | 「excel-copy / order-insight 已外挂为 `extensions/<id>/` 视图插件包……**保留完整 Vue 视图/数据/设置能力**」 | 两者均已下记、**不进构建**；随包分发的能力已不存在 |
| `AGENTS.md:186`（§1.9 表） | 「当前实例：`extensions/` = excel-copy / order-insight / shop-accounts」；岛侧 = ae-profit / order-insight / shop-accounts / sk-ui-starter | `extensions/` 侧**已无实例**（`PROJECT_BASELINE.md:60` 已写明"当前无实例"）；岛侧漏了 `excel-copy` |
| `AGENTS.md:301`（§5 SOP 表） | 「自定义清单：`MODULE_IDS=excel-copy,quick-note npm run build`（优先级最高）」 | **正在示范 H-01 的违规操作**；示例应改为 `quick-note` |
| `AGENTS.md:407`（§6.3） | 「129 个通道都经它注册」 | `npm run verify` 现报主进程注册通道 **137** 个；该数字口径需复核 |

`AGENTS.md` 是"AI 编码助手与开发者必须遵循"的基线，而它现在**部分指向已不存在的世界**——
比普通文档滞后更严重：红线 23 的守卫在 `pluginTriage.spec.ts`，而 AGENTS 里教的做法正好触发它。

**建议**：把 §1.5 / §1.8 / §1.9 的「当前实例/分类」改为由 `PROJECT_BASELINE.md` 单点维护、AGENTS 只写规则与指针。
（项目已有此惯例，如 §1.4 结尾「完整清单见 `docs/baseline/PROJECT_BASELINE.md` §6」——照抄即可。）

---

### M-04 🟠 P2 · 两个岛把设置页做在岛内，与 AGENTS 的「宿主是唯一入口」不一致

**位置**：`AGENTS.md` §1.5（两类设置贡献表 + 「岛内不再重复实现设置页：宿主是唯一入口」）
对照三个岛的 `manifest.json` 实测：

```
shop-accounts   settings={"entry":"./dist/settings.html","displayName":"账号管家","icon":"key","order":50}  ✅ 走正路
excel-copy      settings=无    ← 设置是**岛内视图**（复制工作台 / 设置 两个页签）
order-insight   settings=无    ← 同上
```

**为什么算问题**：

- 按 AGENTS §1.5 的约定，岛的设置应由 `manifest.settings` 贡献给宿主，由 `IslandSettingsPanel.vue`
  以 iframe 承载、进「设置」模态的**分类导航**；岛内只需一个「设置」按钮调 `sk.host.ui.openSettings(...)`。
- 实际做法（岛内自建设置页签）把设置**关在岛里**：用户无法从「设置」模态直达，
  ⌘K / 设置搜索也覆盖不到；同时它与宿主设置页的交互惯例（tab 切换、返回、草稿保存）是各写一套。
- 这不是"坏了"，而是一处**机制分叉**：两种形态并存会让后来者不知道该照哪个写
  （`AGENTS.md` §5 的 SOP 表也在用 `excel-copy` / `order-insight` 当"参考实现"）。

**为什么不建议立刻改**：这两个模块的设置与工作台是**强联动**的 —— excel-copy 改模板要立刻看复制预览、
order-insight 的字段规则要对着当前订单列表调。搬到宿主设置模态后，用户的"改一下、看一眼"循环会被打断。
所以这需要一次**产品判断**（见 §6 待决策项），而不是纯技术收编。

**本轮处置**：在 `AGENTS.md` §1.5 就地标注**已知偏差**并说明理由与代价，避免规则与实际继续各说各话；
实际收编与否留待决策。

---

### L-01 🟡 P3 · 「留档」目录其实是半挂载：被测试与类型检查引用

```ts
// tests/colorSwatch.spec.ts:9
import { COLOR_SWATCH, UNKNOWN_SWATCH, swatchOf } from '../extensions/order-insight/src/lib/colorSwatch';
```

- 该目录被标为「**已下记，留档**」（`PROJECT_BASELINE.md:85`、`:62`），却在**门禁链路里活着**：
  `tsconfig.json` 的 `include` 含 `extensions/**/*.ts|*.vue`，`eslint.config.mjs` 覆盖 `extensions/**`，
  外加这条测试 import。
- `PLUGIN_TRIAGE_PLAN.md:215` 明确提议过 `git rm -r extensions/order-insight` —— **照做会同时打挂
  `colorSwatch.spec.ts` 与 `vue-tsc`**，而那两个文件都不会提示"因为留档被删了"。
- 另外，`colorSwatch.ts` 是**纯函数字典**（色名 → 色值），按 AGENTS §1.2 的目录语义应在 `src/lib/`，
  现在挂在插件包目录下，属历史遗留。

**建议**：把 `colorSwatch.ts` 迁到 `src/lib/`（改 `tests/colorSwatch.spec.ts` 的 import 与 `AGENTS.md:144` 的引用），
此后留档目录才真的"不进任何链路"，将来删除才是无痛的。

---

### L-02 🟡 P3 · 权限门文档与实现不一致（`secrets` 的 `domains`）

`docs/architecture/PLUGIN_DEVELOPMENT.md:190` / `:204` 称 `secrets.status()` 「需声明 `secrets` + `domains`」。
实际 `gatedHost.ts:93-98` 传的是 `{ capability:'secrets', action:'status' }`——**不带 `domain`**；
而 `security.ts:113-122` 的域校验是 `if (req.domain) { ... }`，没有 domain 就整段跳过。
**结论：`secrets` 声明 `domains` 没有任何作用**（现无岛使用 secrets，所以尚未暴露）。
`mail` 那条是对的（`gatedHost.ts:101` 硬编码 `domain:'mail'`，所以 manifest 必须写 `domains:['mail']`）。

---

### L-03 🟡 P3 · `engines.sellerkit` 是装饰性的

`externalManifest.ts:76` 只要求 `isStr(engines.sellerkit)`；全文搜不到任何 semver 范围比对。
即 `engines.sellerkit: ">=99.0.0"` 的插件照样安装并激活。要么真的比对（宿主版本 vs 范围），
要么在文档里说清"仅作声明"，别让插件作者以为写了就有效。

---

### L-04 🟡 P3 · 记录与注释滞后

- `CHANGELOG.md` 停在 `## [Unreleased]`（内容为 R3 依赖升级），**三轮下记（shop-accounts / order-insight / excel-copy）
  与 UI 岛设置贡献之外的新增均未记录**；`package.json` 版本仍 `1.0.4`。
- ~~`LICENSE` 不存在（`CONTRIBUTING.md` 已在）—— R4-6 只完成一半。~~
  **勘误（2026-09-22）**：`LICENSE` 缺失**不是疏漏，而是有意挂起**。`docs/plans/REMEDIATION_PLAN.md`
  的 R4-6（`:392` / `:394` / `:513`）写明：「`LICENSE` ❗**待用户选定协议**——源项目为 fork，
  许可证类型不宜代拟」，风险栏也标注「需你确认许可类型后再写」。
  故本轮**不代拟 LICENSE**；这条从缺陷清单移出，转为**待用户决策项**（见 §6）。
- 注释滞后 4 处：
  - `vite.config.ts:12`「物理外置后 excel-copy / order-insight 走 extensions 根」——现已下记；
  - `electron/shop-accounts-handlers.ts:2`、`electron/shop-accounts-db.ts:1` 仍称「（`extensions/shop-accounts`）」——该目录 2026-09-16 已删；
  - `src/core/plugin/externalManifest.ts:84` 注释称「白名单识别（onStartup / **onCommand:xxx** …）」，而实现是
    `.filter((e) => e === 'onStartup')`——`onCommand:*` 会被**静默丢弃**，插件作者按注释写会得到"永远不激活"。

---

## 2. 已核实**无问题**的部分（正面结论，避免重复排查）

| 项 | 核实方式 | 结论 |
|---|---|---|
| 市场安装解压 | 读 `plugins-market-handlers.ts:92-174` | zip-slip 逐条 `path.relative` 校验 + 软链拒绝（mode `0o120000`）+ sha256 强制 + `manifest.name/version/entry` 三方一致 + 原子 `rename`。**扎实** |
| `sk-plugin://` 路径穿越 | 读 `plugin-ui-protocol.ts:73-100` | 三段防护：段级白名单（拒 `..`/`\`/`:`/`\0`）→ `path.relative` 包含性 → `realpath` 防软链逃逸。**扎实** |
| 岛 CSP | `plugin-ui-protocol.ts:49-51` | `script-src 'self'` 确无 `'unsafe-eval'` → excel-copy 把规则求值放宿主的决策**是必要而非偏好**，已被守卫钉住 |
| iframe sandbox | `UiIslandView.vue:17` | `allow-scripts allow-forms allow-same-origin`：因岛与宿主**跨源**（`sk-plugin://` vs `file://`/`localhost`），`allow-same-origin` 不构成"沙箱逃逸组合"，且是岛加载自身资源所必需。**可接受** |
| UI 岛是否过权限门 | `managerDiscover.ts:125` | 一律 `createGatedHostApi(...)`，**不存在"岛拿 raw host"的旁路** |
| `db` 的能力校验强度 | `gatedHost.ts:87-92` + `security.ts:90,113-123` | `action`(op) + `domain` **双重**校验，且 `domains` 缺省=不放行任何域 → op 白名单与域白名单无法互相绕过（跨域同名 op 也被域拦下） |
| 广播事件与泄漏 | `npm run verify` | 141 暴露键 / 141 类型声明 / 137 注册通道，`✅ IPC 契约一致`；2 处广播双向对称 |
| 市场目录 ↔ 安装包一致性 | 逐个 `sha256` 实算比对（6 个条目）+ 解出 zip 内 manifest 校验 | 6/6 sha256 **全匹配**；各包 `kind: ui`、`entry: ./dist/index.html`、`engines.sellerkit` 齐备；`extensions/` 下 2 个留档目录 + 2 个脚手架被正确识别为 `skipped` |
| 主进程模块纪律 | 读各 handler 文件头 | 均有 `export {}`（红线 12）✓ |
| `TODO/FIXME/HACK` | 全仓 grep | `src/` 与 `electron/` **0 命中** |
| 空预设构建链路 | 读 `vite.config.ts:38-45`、`:113-119` | 上一轮的两处修复（`??` 取代 `||`、占位注释与 `};` 分行）**有效**：`MODULE_PROFILE=minimal` 可构建 |
| 设置分类残留 | grep `src/` 的 `category: 'excel'` | **0 命中** —— 宿主无代码仍指向已消失的 `excel` 分类 |

---

## 3. 门禁实测（本次复查时点）

| 门禁 | 实测结果 |
|---|---|
| `npx vue-tsc --noEmit` | ✅ 0 error |
| `npx tsc -p tsconfig.electron.json --noEmit` | ✅ 0 error |
| `npx eslint .` | ✅ **0 error** / 362 warning（全为 `no-explicit-any` + `no-console`，非阻断） |
| `npx vitest run` | ✅ 13 文件 / **197 用例**（含 `pluginTriage.spec.ts` 27 例） |
| `npm run verify` | ✅ 141 / 141 / 137，`✅ IPC 契约一致` |
| `npm run verify:docs` | ✅ `✅ 无悬空引用` |

> 六个绿 ≠ 没问题。本报告 10 项**全部落在门禁的盲区**：
> H-01 是"脚本诱导的操作序列"（非静态事实，静态断言看不见）；H-02/M-01/M-02 是"能力过宽"
> （类型与契约都对，只是权限边界没画）；M-03/L-01~L-04 是"文档/注释与现实脱节"（verify:docs 只查链接是否存在，不查陈述是否成立）；
> H-03 是"仓库状态"（门禁在磁盘上跑，不管磁盘有没有存档）。

---

## 4. 建议处理顺序

| 序 | 动作 | 对应 | 成本 |
|---|---|---|---|
| **0** | **先落检查点**：`git add -A && git commit`（+ tag）—— 在此之前不要动下面任何一项 | H-03 | 小 |
| 1 | `select-build.js` 过滤掉已有同名 `ui-plugins/<id>` 的候选（+ 打印提示）；同步 `AGENTS.md:301` 的示例 | H-01、M-03 | 小 |
| 2 | `main.ts` 加 `setWindowOpenHandler` + `will-navigate` 白名单收敛，渲染层加全局拖放兜底 | M-01 | 小 |
| 3 | 收紧 `db[excel-copy]` 的路径权限（先落"模板目录白名单"版），`order-insight` 的图片读同法跟进 | H-02 | 中 |
| 4 | 桥层加总字节预算；`sanitize*` 超限改"拒绝并报错" | M-02 | 小 |
| 5 | 修正 `AGENTS.md` 的 §1.5/§1.8/§1.9 为"规则 + 指针"；顺手清 4 处滞后注释 | M-03、L-04 | 小 |
| 6 | `colorSwatch.ts` 迁 `src/lib/`；`PLUGIN_TRIAGE_PLAN.md` 的 `git rm` 建议加前置条件 | L-01 | 小 |
| 7 | 文档/记录收口：`secrets` 文档修正、`engines` 说清语义、补 CHANGELOG 条目与 LICENSE | L-02、L-03、L-04 | 小 |

> 序 0 是**前置**：不先落检查点，后面每一项修复都没有"改之前"可回退。序 1–2 紧随其后（小改动、堵住可被诱导的真实损害），
> 序 3 需要一次设计决策（路径白名单 vs 不透明句柄）。

---

## 5. 修复记录（2026-09-22）

### 5.1 处置结果

| 序 | 对应 | 结果 | 落点 |
|---|---|---|---|
| **0** | H-03 **+ H-04** | ✅ 先修 `.gitignore` 的 `dist/` 例外，再 `git add -A && git commit`（`9a0f623`）；工作区归零，两岛源码入库（`order-insight` 19 文件 / `excel-copy` 12 文件） | `.gitignore`、git 历史 |
| 1 | H-01、M-03 | ✅ `isUndocked()` 判据进单一事实源，**枚举与构建两处**硬拦；选择器单列「已下记为市场 UI 岛」；`AGENTS.md` 示例改 `quick-note` | `scripts/lib/module-roots.cjs`（+`.d.cts`）、`scripts/select-build.js`、`vite.config.ts`、`AGENTS.md` |
| 2 | M-01 | ✅ `will-navigate` 收敛为「只放行应用自身 URL」集合比对；加 `setWindowOpenHandler(deny)`；渲染层加**捕获阶段**的 document 级拖放兜底（只拦文件拖放） | `electron/main.ts`、`src/core/AppShell.vue` |
| 3 | H-02 **+ H-04 守卫** | ✅ 新增「用户已选文件白名单」（跨会话持久化），收紧 `read-file` / `save-template` / `check-file-exists` / `order-read-local-image`；写模板加 2MB 上限；未授权路径的存在性探测返回 `false`（不泄露信息）。配套：`PluginOverview.capabilityDetails` 把能力明细暴露到管理面板 | `electron/user-file-allowlist.ts`（新）、`electron/main.ts`、`electron/order-handlers.ts`、`src/core/plugin/managerOverview.ts`、`src/core/components/PluginCenter.vue` |
| 4 | M-02 | ✅ 桥层加 64MB 载荷预算（**带早退**的估算，`--` 海量小值也拦得住） | `src/core/plugin/payloadBudget.ts`（新）、`src/core/plugin/uiBridgeHost.ts`、`tests/payloadBudget.spec.ts`（新） |
| 5 | M-03、L-04 | ✅ §1.5 / §1.8 / §1.9 改「规则 + 指针」；通道数 129 → 137；清理 4 处滞后注释并将**被静默忽略的声明**（`onCommand:*`、`secrets.domains`）改为明确告警 | `AGENTS.md`、`vite.config.ts`、`electron/shop-accounts-{handlers,db}.ts`、`src/core/plugin/externalManifest.ts` |
| 6 | L-01 | ✅ `colorSwatch.ts` 迁 `src/lib/`；测试与留档组件改指向新址 | `src/lib/colorSwatch.ts`（新）、`tests/colorSwatch.spec.ts`、`extensions/order-insight/src/components/ProductLibraryView.vue`、`AGENTS.md` |
| 7 | L-02、L-03、L-04 | ✅ `secrets` 无域粒度、`engines` 不做范围比对、合法能力 id「四项→七项」三处修正；CHANGELOG 补三轮下记与本轮修复条目 | `docs/architecture/PLUGIN_DEVELOPMENT.md`、`CHANGELOG.md` |
| 追加 | **H-04** | ✅ `tests/pluginTriage.spec.ts` 新增「岛的运行入口必须真实入库」分组（按岛形态判定「源码真相」位置）；已实测**回退即变红** | `tests/pluginTriage.spec.ts` |
| 追加 | **M-04** | ⏸ 仅就地标注已知偏差 + 理由（改动涉及产品判断，见 §6） | `AGENTS.md` §1.5 |

### 5.2 两处与 §4 原计划的偏差（及理由）

1. **没有打 `v1.1.0` tag。** §4 提议在检查点打 `v1.1.0`，但 `package.json` 仍是 `1.0.4`，
   而仓库里 `v1.0.0/1/2/4` 四个 tag 本就指向同一 commit（`CHANGELOG.md` 已声明「不再补打历史 tag」）。
   这时候补一个"看起来像正式发布"的 `v1.1.0` 会再制造一个错位的版本坐标。
   故改打语义明确的检查点 tag：**`remediation-checkpoint-2026-09-22` → `9a0f623`**。
   是否升版为 `v1.1.0` 属发布决策，留给项目方（见 §6）。
2. **`sanitize*` 没有改成「超限即拒绝」。** §4 序 4 的后半句是「`sanitize*` 超限改拒绝并报错」，
   本轮**只加了桥层体积门禁**。原因：`host.ts` 的 `EC_MAX_RECORDS = 50000` 是**与内建版一致的
   兼容上限**，而 `parseExcel` 返回记录数**不设上限** —— 若把 `applyRules` 改成超限即拒，
   一个 6 万行的 Excel 会从"静默截断到 5 万"变成"整个规则应用报错"，属**行为变更**，
   且会打挂现有大文件流程。这个取舍需要项目方拍板（见 §6），不宜在修复轮里顺手改掉。

### 5.3 验证

| 门禁 | 结果 |
|---|---|
| `npx vue-tsc --noEmit` | ✅ 0 error |
| `npx tsc -p tsconfig.electron.json --noEmit` | ✅ 0 error |
| `npx vitest run` | ✅ **14 文件 / 207 用例**（本轮 197 → 207：`payloadBudget` 10 例 + `pluginTriage` 27 → 33 例） |
| `npm run verify` | ✅ 141 / 141 / 137，契约一致（本轮未增删 IPC 通道） |
| `npm run verify:docs` | ✅ 无悬空引用 |
| `npx eslint .` | ✅ 0 error |
| H-01 实测 | `--list` 不再列出已下记模块；`MODULE_IDS=excel-copy` 构建时**报错并忽略**，registry 无该 id |
| H-04 守卫实测 | 三态验证：正常绿 → 去掉 `.gitignore` 例外变红（3 例）→ 恢复后绿 |
| 构建 | `MODULE_PROFILE=minimal`（空预设）与默认 `standard` 均成功 |

---

## 6. 待决策项（本轮**未**擅自处理）

| # | 事项 | 为什么需要你决定 |
|---|---|---|
| 1 | **`LICENSE` 协议类型** | `REMEDIATION_PLAN.md` R4-6 已注明「源项目为 fork，许可证类型不宜代拟」。本轮**未创建** `LICENSE`（报告初稿把它误列为"未完成"，已勘误） |
| 2 | **是否把 `excel-copy` / `order-insight` 的设置收编进宿主「设置」模态**（M-04） | 涉及产品判断：收编后统一入口，但会打断"改模板 → 立刻看预览"的联动循环 |
| 3 | **`sanitize*` 超限：保持静默截断，还是改为拒绝并报错**（M-02 的后半段） | 影响 >50000 行 Excel 的行为语义（见 §5.2 第 2 条）。若改为拒绝，需同时决定 `parseExcel` 是否也设上限。<br>🗂 **已有候选实现但未采纳、未提交**：`docs/reviews/sanitize-limit-proposal-2026-09-22.patch`（`git apply` 即可预览）——把超限分两类：**配置类**（规则条数 / 表头列数 / 单条字段数 / 文件 64MB）**拒绝并报错**，**数据类**（记录行数 / 单元格长度）**仍截断但回传 `truncation` 元信息**。采纳前需补岛侧消费（`excel-copy` 岛目前不读 `truncation`，也没处理新增的报错分支），否则错误会以未捕获异常的形式冒到岛里 |
| 4 | **是否升版并发布** | `package.json` 仍为 `1.0.4`；本轮只落了一个检查点 tag。是否作为 `v1.1.0` 正式发布由项目方决定 |
| 5 | ~~**`xlsx` chunk 是否改懒加载**（L-05）~~ **已关闭（2026-09-22）** | 二次实测推翻前提：`index.html` 无 modulepreload、入口对 xlsx 是 `import()` 动态导入，宿主侧三处调用本就是 `await import('@/core/services/excel')` → **它已经是懒加载，首屏不加载 492 KB**。原"入口静态依赖"的说法与"L-05 优化建议"一并作废，详见 §5 勘误之勘误 |

---

## 附录 · 复现命令

```bash
# H-01：交互式选择器把已下记模块当候选
node scripts/select-build.js --list
# H-01：勾选后 id 被占回（修复前）
MODULE_IDS=excel-copy npx vite build && head -4 src/registry.generated.ts
npm run build            # ← 复原（默认预设，注册表只剩 quick-note）

# 修复后：构建对被下记的 id 报错并忽略，registry 不含 excel-copy
MODULE_IDS=excel-copy npx vite build 2>&1 | grep '⛔'
grep -c 'excel-copy' src/registry.generated.ts    # -> 0

# 勘误核对：xlsx 是否存在与是否勾选 excel-copy 无关（但"存在" ≠ "首屏加载"）
npm run build 2>&1 | grep xlsx                    # -> dist/renderer/assets/xlsx-*.js 492.36 kB
grep -rn "from 'xlsx'" src/                       # -> src/lib/excelParser.ts（经 core/services/excel 被 host.ts 引用）

# 判断是否"启动即加载"——必须看这两个，而不是只看 chunk 体积
grep -c modulepreload dist/renderer/index.html    # -> 0（无预加载，xlsx 不在首屏链路）
grep -o 'import(`\./xlsx-[^`]*`)' dist/renderer/assets/index-*.js   # -> 动态 import()，非静态 from

# H-04：`dist/` 通配吞掉岛源码（修复前）
git check-ignore -v ui-plugins/excel-copy/dist/main.js      # -> .gitignore:3:dist/
git add -A --dry-run ui-plugins/excel-copy/                 # -> 只有 manifest.json + README.md
git ls-files ui-plugins/order-insight | wc -l               # -> 2（修复后 19）

# H-04 守卫的三态验证（必须用 --no-index，否则已跟踪路径不报"被忽略"）
git check-ignore -q --no-index -- ui-plugins/excel-copy/dist/main.js; echo "exit=$?"   # -> 1（未忽略）
grep -v '^!ui-plugins/' .gitignore > /tmp/gi && cp /tmp/gi .gitignore   # 临时去掉例外
npx vitest run tests/pluginTriage.spec.ts                               # -> 预期 3 例变红
# （验证完务必还原 .gitignore）

# H-01：确认留档目录仍被解析为「可打包」
node -e "const {resolveModuleKind}=require('./scripts/lib/module-roots.cjs');
console.log(resolveModuleKind(process.cwd(),'excel-copy'))"   # -> extensions

# H-02：任意路径读 / 写（主进程无任何路径校验）
grep -n "read-file\|save-template" -A 8 electron/main.ts

# M-01：三处防护缺口的取证
grep -rn "setWindowOpenHandler" electron/ src/          # 无输出
grep -n "will-navigate" -A 8 electron/main.ts           # 只拦 .xlsx/.xls
grep -rn "dragover" src/                                # 无输出（无 document 级兜底）

# M-02：规模上限组合
grep -n "EC_MAX_" src/core/plugin/host.ts
grep -n "handleCall" -A 20 src/core/plugin/uiBridgeHost.ts   # 只校验 arity，不校验体积

# L-01：留档目录被测试引用
grep -rn "extensions/" tests/

# L-03：engines 只查存在性
grep -n "engines" src/core/plugin/externalManifest.ts

# H-03：仓库状态（HEAD 与工作区的距离）
git log -1 --format=%ci                                  # -> 2026-09-16
git status --porcelain | wc -l                           # -> 87
git status --porcelain | grep '^??'                      # -> AGENTS.md / docs/{baseline,plans,reviews}/ / ui-plugins/excel-copy/ 等
git tag -l | while read t; do echo "$t -> $(git rev-list -n1 "$t")"; done   # 多个 tag 指向同一 commit
```
