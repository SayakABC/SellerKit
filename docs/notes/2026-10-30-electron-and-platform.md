# Electron 与平台能力：38 条结论（蒸馏自 6 篇，2026-09-30 ~ 2026-10-28）

> **蒸馏笔记**：由 6 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-electron-and-platform.md`（其余五篇同法，路径见文末清单）

## 1. Electron 渲染进程不支持 `window.prompt`，调用即抛错

**结论**：Electron 渲染进程**不支持 `window.prompt`**，调用即抛 `prompt() is not supported.`。`alert` / `confirm` 有实现（会弹原生样式对话框），**只有 `prompt` 没有**。⇒ 任何"点一下 → 让用户敲一行字"的交互都必须用**自绘输入弹层**，不能用 `window.prompt`。这类错**不会被任何门禁抓到**（类型正确、能构建、页面能挂载），只有真机点到那一步才炸。教训归类：**"平台能力"这类假设必须实测**，别按浏览器的常识推断 Electron。

**取证**（2026-09-30，实跑）：

```bash
# 起一个隐藏窗口，在渲染进程里直接调 prompt
cat > /tmp/prompt-probe.js <<'EOF'
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  await w.loadURL('data:text/html,<html><body>hi</body></html>');
  console.log('PROBE_RESULT ' + await w.webContents.executeJavaScript(`
    (() => { try { return 'value:' + String(window.prompt('t','')); }
      catch (e) { return 'threw:' + e.message; } })()`));
  app.quit();
});
EOF
env -u ELECTRON_RUN_AS_NODE "$(node -e "console.log(require('./node_modules/electron'))")" /tmp/prompt-probe.js --no-sandbox --disable-gpu
# 实测输出： PROBE_RESULT threw:prompt() is not supported.
```

（`env -u ELECTRON_RUN_AS_NODE` 与 `--no-sandbox --disable-gpu` 见项目既有约定——继承到 `ELECTRON_RUN_AS_NODE=1` 时 Electron 会当纯 Node 跑，拿不到 `BrowserWindow`。）

**源**：`2026-09-30-electron-prompt-unsupported`（2026-09-30）

---

## 2. 本仓库现存命中：`stockin.js:950` 的「忽略」功能在真机上必然报错

**结论**：`ui-plugins/order-insight/dist/views/stockin.js:950` 的 `const reason = window.prompt('标记「无需补货」原因（选填，如：已线下拿 / 放弃 / 退单）', '');` → 「拿货对账 › 待拿货缺口 › 忽略」这条功能在真机上**必然报错**（异常还会打断后面的 `ignoreAdd` 调用与 `load/refresh`）。第一/二轮 UX 审查都没能靠静态读发现"它会抛"，只能靠实测。

**取证**：

- `ui-plugins/order-insight/dist/views/stockin.js:950`
  `const reason = window.prompt('标记「无需补货」原因（选填，如：已线下拿 / 放弃 / 退单）', '');`

**源**：`2026-09-30-electron-prompt-unsupported`（2026-09-30）

---

## 3. `window.confirm` 可以用但不该用；项目已有自绘样板

**结论**：`window.confirm` 可以用但**不该用**（Electron 下像系统错误框、不可样式化、与自绘弹层混排在同一个产品里很难看）—— 项目已有自绘样板：`ui-plugins/order-insight/dist/util.js:97-100`、`ui-plugins/excel-copy/dist/util.js:70-105`、`ui-plugins/product-library` 的 `pl-mask` / `pl-dialog`。宿主侧抽 `ConfirmDialog` 的待办见 `docs/plans/UX_POLISH_PLAN.md` P1-2。

**取证**：上列三处文件与行号；待办 `docs/plans/UX_POLISH_PLAN.md` P1-2；相关 `docs/reviews/UX_REVIEW_2026-09-30-R2.md` §2-D2/N3。

**源**：`2026-09-30-electron-prompt-unsupported`（2026-09-30）

---

## 4. Electron 44 移除了 `clipboard.writeImage` ⇒ 「复制给厂家」在真机上一直失败

**结论**：用户报「复制给厂家」弹「复制失败：写入剪贴板失败」。根因是 **Electron 33→44 升级残留**：v44 的 clipboard 重构（RFC 0019，narrow helpers 清理）**删掉了 `writeImage`**（同批还有 `readImage` / `writeHTML` / `availableFormats`），而上一条通道是照 v33 时代 API 写的。v44 起写图只有一条路：`clipboard.write([new ClipboardItem({ 'image/png': new Blob([...]) })])`，且 clipboard 全部方法**转 async**。

**取证**：用户报「复制失败：写入剪贴板失败」；渲染层被吞掉的原始错误 `clipboard.writeImage is not a function`。

**源**：`2026-10-10-electron44-clipboard-writeimage`（2026-10-10）

---

## 5. 三道门禁全绿、只有真机暴露的原因

**结论**：为什么三道门禁全绿、只有真机才暴露：

| 门禁 | 为什么看不见 |
| --- | --- |
| `tsc`（主进程） | 旧实现在 `main.ts`，`require('electron')` 是 `any` —— 调不存在的成员不报错 |
| `npm run verify` | 只核**通道名**三方一致；通道名没变，照样 ✅ |
| `picking:ui` / `today:ui` | 剪贴板是**假桥**，只能验"发出去的是什么"；真写系统剪贴板这一步没人测 |

⇒ 教训：**"运行时 API 存在性"是独立于类型/契约/载荷形状的第四类缺陷**，守卫只能是真调一次真 API。

**取证**：上表三行。

**源**：`2026-10-10-electron44-clipboard-writeimage`（2026-10-10）

---

## 6. 修法：把剪贴板通道外提到 `electron/clipboard-handlers.ts`，拿真类型

**结论**：**新文件 `electron/clipboard-handlers.ts`**（两条剪贴板通道从 `main.ts` 外提）：新代码用 ESM `import { clipboard } from 'electron'` 拿**真类型** —— 再写错 API 名 `tsc` 直接红（实测：变异回 `writeImage` → `TS2339`）。外提的另一个动机：冒烟脚本要 `require` 到 handler 才能对穿，而 `main.ts` 是应用入口（会起窗口、开 ae-receiver），冒烟不能加载它。

**取证**：变异回 `writeImage` 报 `TS2339`。

**源**：`2026-10-10-electron44-clipboard-writeimage`（2026-10-10）

---

## 7. 修法：`new Uint8Array(png)` 而非直接给 Buffer

**结论**：**`new Uint8Array(png)` 而非直接给 Buffer**：① BlobPart 不收 Buffer 的 `ArrayBufferLike`（类型层）② Buffer 底层池化分配，给 `.buffer` 会带上池里无关字节（运行时层）。

**取证**：见上两条理由。

**源**：`2026-10-10-electron44-clipboard-writeimage`（2026-10-10）

---

## 8. 修法：文本通道同批修，`writeText` 也转 async 并补 `await`

**结论**：**文本通道同批修**：`writeText` 也转 async，补 `await` —— 不 await = "发起即成功"，写失败时错误落进 unhandled rejection（界面却是"已复制"）。

**取证**：不 await ⇒ 错误落进 unhandled rejection，界面仍是"已复制"。

**源**：`2026-10-10-electron44-clipboard-writeimage`（2026-10-10）

---

## 9. 守卫：`ipc:shape:smoke` ⑧ 段真写系统剪贴板并读回（23 → 28 → 30 项）

**结论**：**`ipc:shape:smoke` ⑧ 段（真写系统剪贴板 + 读回，23 → 28 → 30 项）**：写入前 `clipboard.clear()` 立基态（不清的话上次残留的图会让断言蒙对）；`has('image/png')` + **读回尺寸 64×64** 内容级验证；拒绝分支（非 PNG / 超 8MB）；文本通道一并读回。**两条变异验过都是真守卫**：① 实现退化成 `writeText` → `success:true` 那条**仍绿**、读回那条红 ② 文本写错内容 → 读回那条红。**`success:true` 单独就是假守卫，别只报状态。**

**取证**：`has('image/png')` + 读回尺寸 64×64；两条变异结果如上。

**源**：`2026-10-10-electron44-clipboard-writeimage`（2026-10-10）

---

## 10. 渲染层失败要 `console.warn` 原始错误

**结论**：**渲染层 `writeClipboardImage` 失败时 `console.warn` 原始错误**：本次 `clipboard.writeImage is not a function` 就是在 `src/core/services/clipboard.ts` 被吞掉、多绕了一轮排查（文案仍只给用户一句人话，§1.10 不变）。

**取证**：`src/core/services/clipboard.ts` 吞掉了 `clipboard.writeImage is not a function`。

**源**：`2026-10-10-electron44-clipboard-writeimage`（2026-10-10）

---

## 11. 真机取证怎么做（可复跑）

**结论**：真机取证的三条做法：

- 起真宿主 + CDP：`env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --no-sandbox --disable-gpu --remote-debugging-port=9222 --user-data-dir=<真实 userData 的 cp -cR 克隆>`；Node 内置 WebSocket 直驱 `Runtime.evaluate`（`fetch('http://127.0.0.1:9222/json/list')` 找页面）。
- 剪贴板读回用独立 Electron 进程（`app.whenReady` + `clipboard.read()`），**别在 CDP 里读**（拿不到系统剪贴板）。
- ⚠️ 主进程改动**必须重启宿主**才生效（HMR 不覆盖）—— 本次用户重启过，所以"旧 API 还在跑"的方向一秒排除（对编译产物与进程的启动时间戳）。
- ⚠️ 本机调试实例与用户 dev 实例**抢同一个端口**（ae-receiver 46211）：用户没关干净时调试实例 `EADDRINUSE` 直接退出，别误读成"应用起不来"。

**取证**：上列命令与端口号。

**源**：`2026-10-10-electron44-clipboard-writeimage`（2026-10-10）

---

## 12. 一次把未提交文件"恢复"成旧版：事故经过（`src/core/services/ipc.ts`）

**结论**：日期 2026-10-28 · 事故文件 `src/core/services/ipc.ts`（工作区有 ~3.1 万行未提交改动，该文件属其中之一）。按时间顺序：要删 `ipc.ts` 里的 `orderApiKey*` 与 `orderQueue*` 声明，写了一个按**起止锚点切片**的 node 脚本：

```js
const [a, b] = cut;
const i = s.indexOf(a), j = b ? s.indexOf(b) : b;
if (i < 0 || (b && (j < 0 || j <= i))) throw new Error('anchor fail');
s = s.slice(0, i) + (b ? s.slice(j) : '');
```

其中一批是"删掉若干 import 名"，**没有结束锚点**，传了 `b = ''`：校验条件 `(b && ...)` 因 `b` 为假而**整段跳过** —— 空锚点既不报错也不检测；拼接时 `(b ? s.slice(j) : '')` 同样因 `b` 为假返回 `''` ⇒ `s = s.slice(0, i)`，**文件被截断到第 9 行**（`i` 就是那个 import 名的位置）。发现后执行 `git checkout -- src/core/services/ipc.ts`，想回到"上一次提交的版本"。但 `checkout` 取的是 **index**，而该文件的新版**从未 `git add`** ⇒ 取到的是 HEAD 的旧版。工作区那 1500 行门面代码（ledger 全部、`shopItems*`、`orderParcel*`、`toolAccount*`、purchase 新通道等约 60 个符号）就此丢失。

**根因是两个独立错误叠加**：脚本对"空锚点"fail-open；恢复动作假设"HEAD == 我动手前的状态"，而这个假设在任何有未提交改动的工作区里都不成立。

**取证**：`git checkout -- src/core/services/ipc.ts` 取的是 index；该文件新版从未 `git add` ⇒ 取到 HEAD 旧版。

**源**：`2026-10-28-ipc-ts-wip-overwrite`（2026-10-28）

---

## 13. 为什么当时判断错了：只看了 `M`，没看相对 HEAD 差多少

**结论**：只看了 `git status` 里 `M src/core/services/ipc.ts`，**没有看它相对 HEAD 差多少**。这个仓库有 177 个文件、31351 行未提交改动 —— 一条 `M` 背后可能是 1500 行的新增。判断"可安全 checkout"的正确前置是 `git diff --stat -- <path>`：若显示大量删除/新增，说明 index 版本是旧代，checkout 等于回滚 WIP。

**取证**：177 个文件、31351 行未提交改动；`git diff --stat -- <path>`。

**源**：`2026-10-28-ipc-ts-wip-overwrite`（2026-10-28）

---

## 14. 恢复途径逐条排查（全部失败）

**结论**：恢复途径全部失败，记下来省下次的时间：

| 途径 | 结果 |
| --- | --- |
| `git stash list` | 空 |
| `git fsck --dangling` 的 14 个 blob | 逐个全文搜索目标符号，无命中 |
| 编辑器 Local History（Code / CodeBuddy CN / Qoder 三个 `User/History`） | 目录存在但无该文件条目 |
| `CodeBuddy CN/Backups`、`Code/Backups` | 空 |
| Time Machine | `tmutil destinationinfo` 无目标 |
| 其他 worktree / 仓库副本 | 无 |
| `dist/renderer/assets/*.js`（当天 11:15 构建） | 方法名仍在（**可作清单校验**），但无 sourcemap，无法还原源码 |

**取证**：上表七行。

**源**：`2026-10-28-ipc-ts-wip-overwrite`（2026-10-28）

---

## 15. 怎么重建：判据只有一个（`vue-tsc` 错误集合回到既有错误）

**结论**：判据只有一个：**`vue-tsc` 的错误集合回到"只剩与本次改动无关的既有错误"**。第一步是**两边夹出符号全集**：`src/types.ts` 的 `ElectronAPI`（227 个成员，渲染层消费面）与 `ipc.ts` 现有符号（182）取差 ⇒ 缺 54 个；再用 `src/types.ts` 里**不存在**的 9 个反查"多出来的"（`ae*` 7 个是 ae 域退场后的遗留，应删；`marketCatalogFetch` / `marketPluginInstall` 是 ipc.ts 自有封装，应留）。

**取证**：227 个成员 vs 182 个符号 ⇒ 缺 54；多出 9 个（`ae*` 7 个 + `marketCatalogFetch` / `marketPluginInstall`）。

**源**：`2026-10-28-ipc-ts-wip-overwrite`（2026-10-28）

---

## 16. 重建用 TypeScript compiler API 而不是正则

**结论**：**用 TypeScript compiler API 而不是正则**生成：读 `ElectronAPI` 的每个 `PropertySignature`，取 `FunctionTypeNode` 的 `parameters` 与返回类型，转成方法签名 + 导出函数（`APIResult` → `ApiResult`）。

**取证**：见上。

**源**：`2026-10-28-ipc-ts-wip-overwrite`（2026-10-28）

---

## 17. 独立导出函数的签名以调用点为准，不能照抄 `ElectronAPI`

**结论**：**独立导出函数的签名以调用点为准**，不能照抄 `ElectronAPI`：

- `import { ipc }` 的调用方（如 `host.ts`）用 `ipc.x({ id })` ⇒ 走 interface 成员；
- `import * as ipc` 的调用方（ledger / goods / today）用 `ipc.x(1, 'reason')` ⇒ 导出函数是**位置参数**包装，内部再转成对象（`ledgerEntryVoid(id, reason)` → `{ id, reason }`）。

本次 12 处签名按 `vue-tsc` 报错逐条校正。

**取证**：12 处签名按 `vue-tsc` 报错逐条校正。

**源**：`2026-10-28-ipc-ts-wip-overwrite`（2026-10-28）

---

## 18. 补一个静态校验，抓"编译器没报但也没导出"的漏网

**结论**：**补一个静态校验，抓"编译器没报但也没导出"的漏网**：扫所有含 `import * as ipc from '@/core/services/ipc'` 的文件，提取 `ipc.<name>(` 的调用，与导出函数集合比对 —— 这一步抓出了 `purchaseStyleImages` 与 `orderImageThumbBatch` 两个"interface 里有、导出函数没有"的符号（它们此前只是没人用命名空间调过）。

**取证**：抓出 `purchaseStyleImages` 与 `orderImageThumbBatch`。

**源**：`2026-10-28-ipc-ts-wip-overwrite`（2026-10-28）

---

## 19. 重建后的门禁（逐项 ✅）

**结论**：重建后的门禁：`tsc` ✅ · `verify`「IPC 契约一致」（222 通道）✅ · `vitest` 1107 ✅ · `order:smoke` ✅ · `verify:docs` ✅ · `lint` 0 error · `build` ✅ · `vue-tsc` ✅ 零错误。

**取证**：上列命令与数字（222 通道 / vitest 1107）。

**源**：`2026-10-28-ipc-ts-wip-overwrite`（2026-10-28）

---

## 20. 一处自查结论更正：判"这错是不是我造成的"要看同一契约的其他两端

**结论**：重建后 `vue-tsc` 报 3 条错误，最初判为"既有 WIP 缺口、不擅自补"，**判错了** —— 它们正是被覆盖掉的那部分 WIP，证据在**主进程与 types 两端都已是新形状**：

| 报错 | types.ts（未损） | 主进程（未损） | 结论 |
| --- | --- | --- | --- |
| `orderShippingRows` 缺 `period` | `:87-95` 有 `period?: string` | handler `:188` 传 `sanitizePeriod(payload?.period)` | 丢的是 ipc.ts 的字段 |
| `orderStyleAssign` 返 `colorAlias` | `:182-196` 返 `colorAlias?: ColorAliasRemembered \| null` | handler `:380/411` 回 `colorAlias` | 同上 |
| `purchaseOrderCreate` 要求 `mode` | `:292-298` **无** `mode` | `purchase-db.ts:128` 建单硬编码 `mode: 'detail'` | 丢的是"删掉 mode"这次改动 |

⇒ 教训：**判"这错是不是我造成的"，不能只看 `git diff HEAD`（HEAD 比 WIP 旧，diff 为 0 恰恰说明两边都是旧版）**，要看**同一契约的其他两端**（types + 主进程实现）有没有已经是新形状。三处已按 types.ts 补齐，且逐条回主进程核对过实现确实支持，不是为过类型而编的签名。

**取证**：`types.ts:87-95` / `:182-196` / `:292-298`；handler `:188`、`:380/411`；`purchase-db.ts:128`。

**源**：`2026-10-28-ipc-ts-wip-overwrite`（2026-10-28）

---

## 21. 代价与残留：注释无法恢复，重建源优先级明确

**结论**：

- `ipc.ts` 里**原来的解释性注释无法恢复**（那是本仓的重要资产）。重建部分统一标注 `// ---- 2026-10-28 重建 ipc.ts：签名取自 types.ts 的 ElectronAPI ----`，逐条注释需要后续按实际行为补写，不要当成原文。
- 重建源的优先级：**`types.ts` 的 `ElectronAPI` + `electron/preload.ts` 实现 > HEAD 的 ipc.ts**。本次 3 条类型漂移全部是"信了 HEAD"造成的，已改回。

**取证**：重建标注字符串如上；3 条类型漂移见 §20。

**源**：`2026-10-28-ipc-ts-wip-overwrite`（2026-10-28）

---

## 22. 四条硬规则（下次直接照做）

**结论**：

1. **对含未提交改动的文件，禁止 `git checkout --`**。要恢复先 `cp <path> /tmp/<name>.bak`，或先 `git diff --stat -- <path>` 确认"相对 index 无改动"。
2. **删除脚本的锚点必须双向断言且拒绝空值**：`if (!a || !b || j <= i) throw`；不要用 `b ? ... : ''` 这种"空锚点=删到末尾"的写法 —— 它会把一次误传变成一次截断。
3. **动手前先记基线**：`npx vue-tsc --noEmit > /tmp/vue-tsc.baseline`，否则事后无法证明"这几条错误是本来就有的"。
4. **批量删代码优先用结构化工具**（AST 范围删除）而不是字符串切片；至少要 `node --check` 之外再跑一次类型检查 —— 截断后的文件语法仍可能是合法的（本次截在第 9 行，`tsc` 之外的检查才发现 import 块断了）。

**取证**：见上四条命令与路径。

**源**：`2026-10-28-ipc-ts-wip-overwrite`（2026-10-28）

---

## 23. 付费授权：岛是"预构建静态站点 + 本地明文文件"⇒ 付费墙不可能靠"藏代码"

**结论**：**岛是「预构建静态站点 + 本地明文文件」⇒ 付费墙不可能靠"藏代码"**。安装即解压落盘，宿主再用只读协议原样喂给 iframe；产物是明文 JS，用户一定能读到、也一定能改。付费能力要么宿主门控（可被 patch，只抬高成本），要么把价值放服务端（真防）。

**取证**：岛包形态与落盘见 `docs/architecture/PLUGIN_ARCHITECTURE.md` §15.2、`electron/plugins-market-handlers.ts`（`unzipSafe` + 原子 `rename` 到 `<userData>/plugins/<id>/`）；明文喂给 iframe 见 `electron/plugin-ui-protocol.ts`（只读特权协议，逐段拒绝 `..`，原样返回包内文件）。

**源**：`2026-09-30-paid-license-enforcement`（2026-09-30）

---

## 24. 判定必须落主进程，岛只能"问"不能自判

**结论**：**判定必须落主进程，岛只能"问"不能自判** —— 与本项目"宿主 = 平台、岛 = 插件"的结构同构，对应 JetBrains Marketplace 的官方做法（授权在平台侧，插件不打包校验代码，凭公钥验签服务器签发的凭据）。落点选 `security.ts` 的 `decidePermission()`：它是**纯函数**且被 vitest 覆盖，entitlement 快照由调用方注入，可继续单测；它与 ADR-002 的 C4 `domains` 判定**正交**，不动后者。

**取证**：`src/core/plugin/security.ts` 的 `decidePermission` / `AuditEntry` / `createPermissionGate`（放行与拒绝**都**入审计环）。

**源**：`2026-09-30-paid-license-enforcement`（2026-09-30）

---

## 25. 三个执法点已经存在，零新协议、零新 db 域

**结论**：**三个执法点已经存在，零新协议、零新 db 域**：① 安装门 = `plugins-market-install`；② 激活门 = `managerActivate` / `pluginManager`；③ 调用门 = `DB_OPS` 给 op 加 `requires` 声明 + `security.ts` 判定（③ 是唯一能覆盖"用户手动把 zip 拷进插件目录"的门，且可复用现有权限审计环做展示）。因为**只给现有 op 加字段、不新增 op**，不受 ADR-002 N5 的 op 预算（≤10）约束。

**取证**：调用门落点 `src/core/plugin/host.ts` 的 `DB_OPS`（域 → op 闭表白名单）、`src/core/plugin/gatedHost.ts`（宿主侧唯一授权入口）；激活门与降级态可复用的 UI 链路 `src/core/plugin/managerActivate.ts`、`src/core/plugin/pluginManager.ts`（岛独立轨道 `uiIslands` + 统一停用集 `disabled`）、`src/core/AppShell.vue` 的 `onStateChange → refreshMetas()`；审计展示位（零新 UI）`src/core/components/PluginCenter.vue` 的「权限审计 · 最近被拒绝的调用」区。

**源**：`2026-09-30-paid-license-enforcement`（2026-09-30）

---

## 26. 授权态不要沿用 `token.ts` 的 localStorage 路线

**结论**：**授权态不要沿用 `src/core/network/token.ts` 的 localStorage 路线**（渲染层 DevTools 可读可改）。必须落主进程 + `safeStorage` / electron-store 加密，渲染层只拿只读快照。

**取证**：现有不安全先例 `src/core/network/token.ts`（`localStorage` 存 `sk_auth_token`）；客户端可被 patch：ASAR 是拼接归档非加密；`EnableEmbeddedAsarIntegrityValidation` / `OnlyLoadAppFromAsar` **默认关**（macOS ≥16 / Windows ≥30）；CVE-2024-46992（Windows 绕过，30.0.5 / 31.0.0-beta.1 已修）、CVE-2025-55305（V8 heap snapshot 不在 ASAR integrity 保护内）。官方与第三方口径一致：客户端保护不绝对，须配合服务端校验。

**源**：`2026-09-30-paid-license-enforcement`（2026-09-30）

---

## 27. 定案（2026-09-30 用户拍板）

**结论**：收费客体 = **Pro 档功能**（不锁 App、不按岛收费）；计费 = **月 + 年双档订阅**；后端 = **零自建**（托管授权 API + 托管收银）；到期 = **降级为免费版**（Pro 能力不可调用，基础功能与数据照常）。完整方案与改动清单见 `docs/plans/PAID_LICENSE_PLAN.md`。仍未拍板：托管方选型、免费版与 Pro 的功能切分、未授权时闸门②的表现、宽限期天数（建议 14 天）。

**取证**：`docs/plans/PAID_LICENSE_PLAN.md`。

**源**：`2026-09-30-paid-license-enforcement`（2026-09-30）

---

## 28. 「产品页的图片没有展示」根因：通道名一致 ≠ 载荷形状一致

**结论**：用户报「**产品页的图片没有展示**」。先按"没数据"排：库里的确有数据缺失 —— 27 个产品 `image_id` 全为 0、`pl_images` 空、`product-images/` 目录都不存在、`pl_shop_sku.image_url` 全空。**但这不是全部**：同一个缩略图通道在「映射与关联」页本该有图（订单域有 42 张带图订单 / 32 个 `order-images` 文件，三层回落实测能解析到真实 webp 路径），那里也是空的。所以问题在**通道**，不在数据。真因：`order-image-thumb-batch` 的**载荷形状在渲染层声明与 preload 实现之间不一致**——传进去的数组被当成"没有 items 的对象"，发出去的是 `{ items: [] }` ⇒ 主进程正常返回 `{ success: true, data: { dataUrls: [] } }` ⇒ 调用方 `forEach` 空数组 ⇒ **界面全是空占位，且不报任何错**（调用方的 `catch` 兜的是异常，兜不住"成功但空"）。

| 位置 | 约定的形状 |
| --- | --- |
| `src/types.ts`（`ElectronAPI`，**声明**） | `orderImageThumbBatch(items: {...}[])` —— **裸数组** |
| `src/core/services/ipc.ts`（包装函数） | 同上，数组直传 |
| `src/core/plugin/host.ts`（岛桥 `DB_OPS`） | `ipc.orderImageThumbBatch(p.items)` —— 数组 |
| 4 个内置调用点（产品页主图列 / 映射与关联的商品ID图 / 编辑抽屉主图预览 / 拣货单商品图） | 数组 |
| `electron/preload.ts`（**唯一实现**） | 只读 `payload?.items` |

**取证**：**用真 preload 取证**（不是读代码猜）：把 `dist/electron/preload.js` 装进打了桩的 `ipcRenderer`，按声明传裸数组 ——

```
按 types.ts 契约传裸数组  → 载荷 {"items":[]}
传 { items: [...] }       → 载荷 {"items":[{...},{...}]}
```

**源**：`2026-10-04-preload-payload-shape`（2026-10-04）

---

## 29. 修法：preload 两种形状都收 + 渲染层按 40 拆批

**结论**：

1. `electron/preload.ts` 的 `orderImageThumbBatch` 改为**两种形状都收**（裸数组优先，`{ items }` 兼容岛侧老调用方）—— 单一实现改一处，7 个调用点都不用动，**不动 IPC 契约**（无新通道、无能力域变更、岛无需发版）。
2. 顺手堵掉同族的第二个静默缺口：主进程与 preload 都按 `slice(0, 40)` 硬截断，而调用方是"按页/按单"给路径的（产品页一页 50 行、拣货单可能上百）⇒ 超出的行**静默空图**。改成在渲染层包装函数（`src/core/services/ipc.ts` 的 `orderImageThumbBatch`）**按 40 拆批**：顺序不打乱、单批失败按 `null` 补位（不让一批的失败作废其余批次）。

**取证**：`slice(0, 40)` 硬截断；按 40 拆批，单批失败按 `null` 补位。

**源**：`2026-10-04-preload-payload-shape`（2026-10-04）

---

## 30. 守卫：`npm run verify` 挡不住载荷形状，需新增两道

**结论**：`npm run verify`（`check-ipc-contract.mjs`）只核**通道名**三方一致，**看不见载荷形状**。新增两道：

| 门禁 | 覆盖 | 关键设计 |
| --- | --- | --- |
| `npm run ipc:shape:smoke` | 真 preload + 真主进程 handler 对穿（进程内替换 `ipcRenderer.invoke`/`ipcMain.handle`，其余 electron 成员保持真实） | 正面（裸数组必须出 `data:image/*`）+ **反面**（缺失/越权路径必须 `null`，证明"非空"不是恒真）+ 40 项逐项对号 + 同族三条通道形状 |
| `tests/thumbBatchChunk.spec.ts` | 渲染层拆批（假 `window.electronAPI`） | 分批大小 / 返回长度 / 逐项顺序 / 坏批补位 / 空数组不往返 |

变异复核：① 把 preload 改回"只认 `{ items }`" ⇒ 冒烟 7 项红；② 去掉渲染层拆批 ⇒ 单测 2 项红；均已复原。

**取证**：冒烟 7 项红 / 单测 2 项红。

**源**：`2026-10-04-preload-payload-shape`（2026-10-04）

---

## 31. 两个夹具陷阱：1×1 PNG 被判 empty、必须真 Electron

**结论**：两个夹具陷阱（本轮踩到，都已写进脚本注释）：

- **1×1 的 PNG 会被 Chromium 判成 empty**（`nativeImage.createFromBuffer` 解不出内容）——拿它当素材，"通道坏了"和"素材太小"长得一模一样。改用"按 BGRA 原始位图建图再 `toPNG()`"造真 PNG。
- 这个冒烟要**真 Electron**（nativeImage 真解码）；`ELECTRON_RUN_AS_NODE=1` 时 `require('electron')` 只是路径字符串，`app` 是 undefined —— 脚本首行加早退护栏直接说清怎么跑，别让人对着一句 `Cannot read properties of undefined` 猜。

**取证**：`nativeImage.createFromBuffer` 对 1×1 PNG 判 empty；`ELECTRON_RUN_AS_NODE=1` 时 `app` 是 undefined。

**源**：`2026-10-04-preload-payload-shape`（2026-10-04）

---

## 32. 遗留（未修，需要用户决策）

**结论**：

1. ~~岛的订单详情缩略图不显示（`DB_OPS` 返回 `{ dataUrls: [...] }`，岛按 `map[localPath]` 取值）~~ **已自然消失**：调用它的那个岛（「订单归类」）已于 **2026-10-05 整体下架**，随之下线的还有那个返回 `{ dataUrls }` 的 `order.imageThumbBatch` op（宿主 `DB_OPS` 的 `order-insight` 域整域删除）。**这条遗留不需要再修** —— 但它记下的教训仍然有效：桥两侧的形状口径要有一道端到端断言（见 §28 与 `npm run ipc:shape:smoke`）。
2. **渲染层那一段接线仍然零覆盖**：`产品页 loadThumbs → thumbs.get(p.id) → <img>` 的映射（`items[i].key` 对号）没有任何自动化断言；`goods:ui` 的假桥还把 `orderImageThumbBatch` 复刻成了**旧形状**（`p.items`），恰好把这个 bug 挡住 —— 假桥是"抄一份行为"，不是"引用实现"，天生抓不到"实现与声明不一致"。要补的话得给该冒烟加"带主图的夹具 + 忠实假桥"。

**取证**：`order-insight` 域整域删除；`goods:ui` 假桥复刻成 `p.items`。

**源**：`2026-10-04-preload-payload-shape`（2026-10-04）

---

## 33. `shell.openExternal` 只能开系统默认浏览器，开不了指定浏览器

**结论**：**`shell.openExternal` 只能开"系统默认浏览器"，开不了"指定浏览器"**。Electron 这个 API 没有"用哪个 app 打开"的参数，且 `shell.openExternal` 的第二个参数（`activate` / `workingDirectory`）也管不到应用选择 ⇒ 要指定浏览器只能自己起进程（`open` / `chrome.exe`）。原实现就是 `shell.openExternal(url)`：默认浏览器不是 Chrome 时，「打开店铺」开在**没有采集扩展的浏览器**里，用户看到的是"页面开了，但找不到采集按钮"——而且他没有任何线索知道为什么。

**取证**：原实现 `shell.openExternal(url)`；第二个参数（`activate` / `workingDirectory`）管不到应用选择。

**源**：`2026-10-16-open-external-prefer-chrome`（2026-10-16）

---

## 34. 为什么必须是 Chrome：动线的一部分

**结论**：**为什么必须是 Chrome**：SellerKit 的采集能力由 Chrome MV3 扩展（`SellerKitExtensions` / `ae-profit`）提供，「打开店铺」这个按钮的**下一步动作**就是点扩展的采集按钮。所以"用哪个浏览器"不是审美偏好，是**动线的一部分**。

**取证**：扩展名 `SellerKitExtensions` / `ae-profit`。

**源**：`2026-10-16-open-external-prefer-chrome`（2026-10-16）

---

## 35. 两件事不能合并成一个概念：固定策略 vs 运行时事实

**结论**：本轮的设计边界：

- 「用哪个浏览器」= 本次是**固定策略**（Chrome 优先，无设置项、无 UI）；
- 「Chrome 到底能不能用」= **运行时事实**，随时可能为假 ⇒ **探测失败必须回落**，绝不返回失败。回落代价只是"少了采集扩展"（用户至少看到了页面），报错的代价是"入口失效"。别把探测结果写成用户偏好值：偏好被改坏 / 装了挪位置的 Chrome，都会退化成"点了没反应"。

**取证**：见上两条定义。

**源**：`2026-10-16-open-external-prefer-chrome`（2026-10-16）

---

## 36. 判据按平台各写一份，不能抄（三个平台的失败信号完全不同）

**结论**：**判据按平台各写一份，不能抄**：

- **macOS**：`open -b com.google.Chrome <url>`。⚠️ 找不到 app 时**命令本身是成功的**（`spawn` 不报错、没有 `error` 事件），失败**只体现在退出码 1** ⇒ 必须看 `exit code === 0`。
- **Windows**：按已知安装路径找 `chrome.exe`（用户级 `%LOCALAPPDATA%\Google\Chrome\Application\` 才是默认落点，不能只看 Program Files）。⚠️ chrome.exe 若**已在运行**，它自己就是常驻进程，`exit` 可能永远不来 ⇒ 靠**超时判成功**（"还活着" = 浏览器起起来了）。
- **Linux**：按 PATH 依次试 `google-chrome` / `chromium` 等命令名，靠 `error`(ENOENT) 判"这个命令不存在"。

**取证**（darwin，2026-10-16）：

```
# ① 关键判据：找不到 app 时命令成功但退出码非 0（只按 spawn error 判会永远判成功）
$ open -b com.google.chrome.definitely.missing https://www.example.com/
LSCopyApplicationURLsForBundleIdentifier() failed while trying to determine the application ...
EXIT_NONEXISTENT=1
```

**源**：`2026-10-16-open-external-prefer-chrome`（2026-10-16）

---

## 37. 只改主进程一处出口，渲染层零逻辑改动

**结论**：**只改主进程一处出口，渲染层零逻辑改动**：两个「打开店铺」入口（「待关联采集商品」段的下拉、「基础数据 › 店铺登记」行内的「打开」）都走 `open-external` 通道 ⇒ 通道形状、入参、中文错误文案一字未变。

改动点：

| 位置 | 内容 |
| --- | --- |
| `electron/browser-open.ts`（新增） | `openUrlInPreferredBrowser(url)`：Chrome 优先 + 按平台探测 + 失败回落 `shell.openExternal`；返回 `'chrome' \| 'system'`（只用于观测，不决定成败） |
| `electron/clipboard-handlers.ts` | `open-external` 的 `shell.openExternal` 换成 `openUrlInPreferredBrowser`；`shell` import 撤掉；注释说明"优先 Chrome"的理由 |
| `electron/main.ts` / `preload.ts` / `src/types.ts` / `src/core/services/ipc.ts` / `useSkuPool.ts` / `PoolPane.vue` / `ShopRegistryView.vue` | 注释同步（"系统默认浏览器" → "优先 Chrome，用不了回落系统默认"）；**无逻辑改动** |

**取证**：真机实测（darwin，2026-10-16）：

```
# ② 正路：真跑 openUrlInPreferredBrowser（electron 主进程内）
RESULT=chrome MS=60

# ③ 回落：把 bundle id 变异成不存在的（改 dist 里的常量）后重跑
RESULT=system MS=33      # 走 shell.openExternal，无异常、无未捕获拒绝
```

**变异/还原**：改的是 `dist/electron/browser-open.js`（源码没留开关）；跑完从备份回拷并 `npx tsc -p tsconfig.electron.json` 重编，`grep` 确认常量回到 `com.google.Chrome`（本仓既有坑：还原后不编译 = 后续门禁红在残留变异体上）。

**源**：`2026-10-16-open-external-prefer-chrome`（2026-10-16）

---

## 38. 未实测（下次接手须知）+ 四条坑

**结论**：

**未实测（下次接手须知）**

- **Windows / Linux 分支**：本机是 darwin，这两条路径只有代码推理，没有实跑。Windows 首次落地时**必须**实测两件事：① 用户级安装（`%LOCALAPPDATA%`）能被找到；② Chrome **已运行**时 `spawn` 的进程不退出 ⇒ 不能等 `exit` 才判成功（现靠超时兜）。
- **Chrome 冷启动**：实测那次 Chrome 已在运行（`open` 立即退出码 0）。冷启动时 `open` 同样立即返回、不等 app ready，判据不受影响，但没有实测样本。

**坑（下次照着绕）**

1. **⭐ 平台 API 的"失败信号"必须真机跑一次才知道落在哪**。`open -b` 找不到 app 时不报 spawn 错，只在退出码上体现 —— 如果按"spawn 没抛错就算成功"写，Chrome 缺失时会**静默不回落**，表现正是"点了按钮什么都没发生"（本条改动本来要修的就是这类症状）。
2. **浏览器是常驻进程**：`spawn` 必须 `detached: true` + `stdio: 'ignore'` + `unref()`，否则 Electron 退出会被子进程拦住（Windows 上还多一条 `windowsHide: true`，防闪控制台窗口）。
3. **electron 的 `process.argv` 会被 Chromium 开关占位**：实测 `argv.slice(1) === ["--no-sandbox","--disable-gpu","/tmp/x.cjs"]` ⇒ 写一次性探针脚本时别用 `process.argv[2]` 取参数（会拿到脚本路径，函数收到 `undefined` 后落到 `shell.openExternal` 报 `Invalid URL`，看起来像"实现有 bug"）。用环境变量传参。
4. **别为这条加"设置项"**（本轮明确不做）：加了就变成"用户可以把入口改坏成没有扩展的浏览器"，而失败时没有任何提示能救回来。要放开也得先有"当前浏览器是否装了扩展"的判据。

**取证**：`argv.slice(1) === ["--no-sandbox","--disable-gpu","/tmp/x.cjs"]`；`RESULT=chrome MS=60` / `RESULT=system MS=33`。

**源**：`2026-10-16-open-external-prefer-chrome`（2026-10-16）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-09-30-electron-prompt-unsupported.md` | 2026-09-30 | §1 / §2 / §3 |
| `2026-10-10-electron44-clipboard-writeimage.md` | 2026-10-10 | §4 / §5 / §6 / §7 / §8 / §9 / §10 / §11 |
| `2026-10-28-ipc-ts-wip-overwrite.md` | 2026-10-28 | §12 / §13 / §14 / §15 / §16 / §17 / §18 / §19 / §20 / §21 / §22 |
| `2026-09-30-paid-license-enforcement.md` | 2026-09-30 | §23 / §24 / §25 / §26 / §27 |
| `2026-10-04-preload-payload-shape.md` | 2026-10-04 | §28 / §29 / §30 / §31 / §32 |
| `2026-10-16-open-external-prefer-chrome.md` | 2026-10-16 | §33 / §34 / §35 / §36 / §37 / §38 |

**关联索引（原笔记自带，未并入正文）**

- `docs/features/MAIL_INBOX.md`（同日修的另一处图片问题）、`AGENTS.md` §6（门禁清单）—— 源自 `2026-10-04-preload-payload-shape`。
- `docs/reviews/UX_REVIEW_2026-09-30-R2.md` §2-D2/N3 —— 源自 `2026-09-30-electron-prompt-unsupported`。
