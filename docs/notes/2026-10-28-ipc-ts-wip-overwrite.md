# 一次把未提交文件"恢复"成旧版的完整复盘：脚本空锚点 + `git checkout` 的组合杀

日期：2026-10-28 · 事故文件：`src/core/services/ipc.ts`（工作区有 ~3.1 万行未提交改动，该文件属其中之一）

## 一、发生了什麼（按时间顺序，不省略）

1. 要删 `ipc.ts` 里的 `orderApiKey*` 与 `orderQueue*` 声明，写了一个按**起止锚点切片**的 node 脚本：

   ```js
   const [a, b] = cut;
   const i = s.indexOf(a), j = b ? s.indexOf(b) : b;
   if (i < 0 || (b && (j < 0 || j <= i))) throw new Error('anchor fail');
   s = s.slice(0, i) + (b ? s.slice(j) : '');
   ```

2. 其中一批是"删掉若干 import 名"，**没有结束锚点**，我传了 `b = ''`。
   - 校验条件 `(b && ...)` 因 `b` 为假而**整段跳过** —— 空锚点既不报错也不检测；
   - 拼接时 `(b ? s.slice(j) : '')` 同样因 `b` 为假返回 `''` ⇒ `s = s.slice(0, i)`，
     **文件被截断到第 9 行**（`i` 就是那个 import 名的位置）。
3. 发现后执行 `git checkout -- src/core/services/ipc.ts`，想回到"上一次提交的版本"。
   但 `checkout` 取的是 **index**，而该文件的新版**从未 `git add`** ⇒ 取到的是 HEAD 的旧版。
   工作区那 1500 行门面代码（ledger 全部、`shopItems*`、`orderParcel*`、`toolAccount*`、
   purchase 新通道等约 60 个符号）就此丢失。

**根因是两个独立错误叠加**：脚本对"空锚点"fail-open；恢复动作假设"HEAD == 我动手前的状态"，
而这个假设在任何有未提交改动的工作区里都不成立。

## 二、为什么当时判断错了

- 我只看了 `git status` 里 `M src/core/services/ipc.ts`，**没有看它相对 HEAD 差多少**。
  这个仓库有 177 个文件、31351 行未提交改动 —— 一条 `M` 背后可能是 1500 行的新增。
- 判断"可安全 checkout"的正确前置是 `git diff --stat -- <path>`：
  若显示大量删除/新增，说明 index 版本是旧代，checkout 等于回滚 WIP。

## 三、恢复途径逐条排查（全部失败，记下来省下次的时间）

| 途径 | 结果 |
| --- | --- |
| `git stash list` | 空 |
| `git fsck --dangling` 的 14 个 blob | 逐个全文搜索目标符号，无命中 |
| 编辑器 Local History（Code / CodeBuddy CN / Qoder 三个 `User/History`） | 目录存在但无该文件条目 |
| `CodeBuddy CN/Backups`、`Code/Backups` | 空 |
| Time Machine | `tmutil destinationinfo` 无目标 |
| 其他 worktree / 仓库副本 | 无 |
| `dist/renderer/assets/*.js`（当天 11:15 构建） | 方法名仍在（**可作清单校验**），但无 sourcemap，无法还原源码 |

## 四、怎么重建的（可复用）

判据只有一个：**`vue-tsc` 的错误集合回到"只剩与本次改动无关的既有错误"**。

1. **两边夹出符号全集**：`src/types.ts` 的 `ElectronAPI`（227 个成员，渲染层消费面）
   与 `ipc.ts` 现有符号（182）取差 ⇒ 缺 54 个；再用 `src/types.ts` 里**不存在**的 9 个
   反查"多出来的"（`ae*` 7 个是 ae 域退场后的遗留，应删；`marketCatalogFetch` /
   `marketPluginInstall` 是 ipc.ts 自有封装，应留）。
2. **用 TypeScript compiler API 而不是正则**生成：读 `ElectronAPI` 的每个 `PropertySignature`，
   取 `FunctionTypeNode` 的 `parameters` 与返回类型，转成方法签名 + 导出函数
   （`APIResult` → `ApiResult`）。
3. **独立导出函数的签名以调用点为准**，不能照抄 `ElectronAPI`：
   - `import { ipc }` 的调用方（如 `host.ts`）用 `ipc.x({ id })` ⇒ 走 interface 成员；
   - `import * as ipc` 的调用方（ledger / goods / today）用 `ipc.x(1, 'reason')` ⇒
     导出函数是**位置参数**包装，内部再转成对象（`ledgerEntryVoid(id, reason)` → `{ id, reason }`）。
   本次 12 处签名按 `vue-tsc` 报错逐条校正。
4. **补一个静态校验，抓"编译器没报但也没导出"的漏网**：扫所有含
   `import * as ipc from '@/core/services/ipc'` 的文件，提取 `ipc.<name>(` 的调用，
   与导出函数集合比对 —— 这一步抓出了 `purchaseStyleImages` 与 `orderImageThumbBatch`
   两个"interface 里有、导出函数没有"的符号（它们此前只是没人用命名空间调过）。

重建后的门禁：`tsc` ✅ · `verify`「IPC 契约一致」（222 通道）✅ · `vitest` 1107 ✅ ·
`order:smoke` ✅ · `verify:docs` ✅ · `lint` 0 error · `build` ✅ · `vue-tsc` ✅ 零错误。

**一处自查结论更正（重要）**：重建后 `vue-tsc` 报 3 条错误，我最初判为"既有 WIP 缺口、不擅自补"，
**判错了** —— 它们正是被覆盖掉的那部分 WIP，证据在**主进程与 types 两端都已是新形状**：

| 报错 | types.ts（未损） | 主进程（未损） | 结论 |
| --- | --- | --- | --- |
| `orderShippingRows` 缺 `period` | `:87-95` 有 `period?: string` | handler `:188` 传 `sanitizePeriod(payload?.period)` | 丢的是 ipc.ts 的字段 |
| `orderStyleAssign` 返 `colorAlias` | `:182-196` 返 `colorAlias?: ColorAliasRemembered \| null` | handler `:380/411` 回 `colorAlias` | 同上 |
| `purchaseOrderCreate` 要求 `mode` | `:292-298` **无** `mode` | `purchase-db.ts:128` 建单硬编码 `mode: 'detail'` | 丢的是"删掉 mode"这次改动 |

⇒ 教训：**判"这错是不是我造成的"，不能只看 `git diff HEAD`（HEAD 比 WIP 旧，diff 为 0 恰恰说明
两边都是旧版）**，要看**同一契约的其他两端**（types + 主进程实现）有没有已经是新形状。
三处已按 types.ts 补齐，且逐条回主进程核对过实现确实支持，不是为过类型而编的签名。

## 五、代价与残留

- `ipc.ts` 里**原来的解释性注释无法恢复**（那是本仓的重要资产）。重建部分统一标注
  `// ---- 2026-10-28 重建 ipc.ts：签名取自 types.ts 的 ElectronAPI ----`，
  逐条注释需要后续按实际行为补写，不要当成原文。
- 重建源的优先级：**`types.ts` 的 `ElectronAPI` + `electron/preload.ts` 实现 > HEAD 的 ipc.ts**。
  本次 3 条类型漂移全部是"信了 HEAD"造成的，已改回。

## 六、四条硬规则（下次直接照做）

1. **对含未提交改动的文件，禁止 `git checkout --`**。要恢复先 `cp <path> /tmp/<name>.bak`，
   或先 `git diff --stat -- <path>` 确认"相对 index 无改动"。
2. **删除脚本的锚点必须双向断言且拒绝空值**：`if (!a || !b || j <= i) throw`；
   不要用 `b ? ... : ''` 这种"空锚点=删到末尾"的写法 —— 它会把一次误传变成一次截断。
3. **动手前先记基线**：`npx vue-tsc --noEmit > /tmp/vue-tsc.baseline`，否则事后无法证明
   "这几条错误是本来就有的"。
4. **批量删代码优先用结构化工具**（AST 范围删除）而不是字符串切片；至少要 `node --check`
   之外再跑一次类型检查 —— 截断后的文件语法仍可能是合法的（本次截在第 9 行，`tsc` 之外
   的检查才发现 import 块断了）。
