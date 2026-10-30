# 冒烟与守卫纪律：18 条结论（蒸馏自 4 篇，2026-09-30 ~ 2026-10-05）

> **蒸馏笔记**：由 4 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-smoke-and-guard-discipline.md`（其余三篇同法，路径见文末清单）

## 1. 用户可见文案的守卫首选真机冒烟读 `innerText`，而不是扫源码

**结论**：给"用户可见文案"做回归守卫时，**首选真机冒烟读 `innerText`**（我们已有：`npm run plugins:island:smoke` 的**工具条文案体检**）——读的是"用户**实际看得见**的文本"，因此**折叠区（`v-if` 收起）天然不在里面**：一条断言同时守住两件事 ——「不出现内部术语」与「调试入口必须默认收起」。

**取证**：真机冒烟那条则相反：`document.querySelector('.ui-island-bar').innerText` 拿到的就是像素级呈现，没渲染出来的（折叠的「诊断」）自然拿不到。落地后 6 个岛全绿，且把「等待桥握手…」改回去会立刻变红。

**源**：`2026-09-30-copy-guard-layer`（2026-09-30）

---

## 2. 源码正则只钉结构性事实，**不要拿它判文案**

**结论**：**源码正则只钉结构性事实**（"诊断区存在且被 `v-if="showDiag"` 包着"、"徽标文案来自 `badgeFor`"）——**不要拿它判文案**：注释、被折叠的模板、拼接字符串都会命中 ⇒ 误报会把真信号淹掉。

**取证**：宿主文案散在模板、`:title`、`toast(...)` 实参、事件 dispatch 的字符串里，正则要么扫不全、要么把注释里的术语（本仓注释写得很多）当成违规。**"看起来红了"但红的全是噪声**，等于把校验器改瞎。

**源**：`2026-09-30-copy-guard-layer`（2026-09-30）

---

## 3. 为文案守卫新写「扫源码的 tests/uxCopy」被评估后放弃

**结论**：UX 计划原本要新写一个扫源码的 `tests/uxCopy`。评估后放弃：宿主文案散在模板、`:title`、`toast(...)` 实参、事件 dispatch 的字符串里，正则要么扫不全、要么把注释里的术语（本仓注释写得很多）当成违规。**"看起来红了"但红的全是噪声**，等于把校验器改瞎。

**取证**：同上条；放弃后改用真机冒烟读 `innerText`（见 §1）。

**源**：`2026-09-30-copy-guard-layer`（2026-09-30）

---

## 4. 术语规则成文（`AGENTS.md` §1.10「用户可见文案纪律」）

**结论**：**术语规则成文**（`AGENTS.md` §1.10「用户可见文案纪律」）：禁用族 = 能力域/表名/op 名 · 进程与协议名（宿主/桥/iframe/CSP/realm/token）· 权限审计内部词（越权/权限门）· 内部分级（L0/L2/外置·）· 主键 ID · **悬空功能名**。改写方向：能力/来源/状态说人话 + 空态三段式（现状 + 原因 + 一个可点的下一步）。

**取证**：规则落在 `AGENTS.md` §1.10「用户可见文案纪律」。

**源**：`2026-09-30-copy-guard-layer`（2026-09-30）

---

## 5. 例外要写进规则文件，而不是留在作者脑子里

**结论**：**例外要写明**：插件中心的**权限明细**那一列保留技术细目（哪个域、哪些动作）—— 知情同意需要精确范围。例外写进规则文件，而不是留在作者脑子里；否则下一个人会"顺手统一"掉它。

**取证**：插件中心权限明细列为例外点。

**源**：`2026-09-30-copy-guard-layer`（2026-09-30）

---

## 6. 仍未做：`「X」` 引号里的名字必须是真实存在的入口名

**结论**：`「X」` 引号里的名字必须是**真实存在**的入口名（审查 C4：曾出现全仓不存在的「运费测算」）。这条需要同时认宿主模块名与各岛 `displayName`，白名单不收窄就会误报 —— 留待单独一轮。

**取证**：审查 C4：曾出现全仓不存在的「运费测算」。

**源**：`2026-09-30-copy-guard-layer`（2026-09-30）

---

## 7. 无头冒烟的 `waitFor` 轮询回调必须 try/catch

**结论**：写假桥无头冒烟（`--dump-dom` 取 `#smoke-result` 那一类）时，`waitFor` 的**轮询回调必须 try/catch**；回调里对 `null` 元素取属性会抛错，而 Promise **既不 resolve 也不 reject** → 外层 `await` 永久挂起 → 断言脚本走不到"把结果写进 `<pre id="smoke-result">`"那一步。

**取证**：断言脚本里有一行 `card('go-picking').querySelector(...)`：`card()` 返回 `null`（元素不存在）→ 回调抛 `Cannot read properties of null` → Promise 永不落地 → 页面无 `#smoke-result`。

**源**：`2026-09-30-headless-smoke-waitfor-trap`（2026-09-30）

---

## 8. 症状极具误导性：报「✗ 没抓到 #smoke-result」而错在断言代码自己

**结论**：**症状极具误导性**：脚本只报「✗ 没抓到 #smoke-result（页面可能没挂载）」——于是排查方向会被带到"产物是不是旧的 / 注入脚本是不是有语法错 / 假桥缺键"上，而**真正的错在断言代码自己**。

**取证**：同一份夹具下，加了 `try/catch` 后立刻报出**真实错误**：`SMOKE: FAILED at [nav] - Cannot read properties of null`。

**源**：`2026-09-30-headless-smoke-waitfor-trap`（2026-09-30）

---

## 9. 正确写法：`waitFor` 的 `catch` 直接 reject

**结论**：正确写法如下（`try { v = fn(); } catch (e) { return reject(e); }` 这一行是关键）：

```js
function waitFor(fn, timeout) {
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    (function tick() {
      var v;
      try { v = fn(); } catch (e) { return reject(e); }   // ← 这一行是关键的
      if (v) return resolve(v);
      if (Date.now() - t0 > (timeout || 4000)) return reject(new Error('timeout'));
      setTimeout(tick, 30);
    })();
  });
}
```

**取证**：上述代码即 2026-09-30 写「今天」首页冒烟时落地的写法。

**源**：`2026-09-30-headless-smoke-waitfor-trap`（2026-09-30）

---

## 10. 涉及"切走"的断言一律放最后一步

**结论**：另一个同源错误：**跳转类断言放在前面会让页面卸载** —— 点「生成待拣清单」会派发 `switch-module`，宿主要求切到别的模块，本页 DOM 随之消失；后续步骤再 `querySelector` 本页元素就是 `null`。⇒ 涉及"切走"的断言**一律放最后一步**。

**取证**：点「生成待拣清单」派发 `switch-module`，宿主要求切到别的模块，本页 DOM 随之消失。

**源**：`2026-09-30-headless-smoke-waitfor-trap`（2026-09-30）

---

## 11. `waitFor` 加固已同步到 5 个内联副本

**结论**：加固已同步到各内联副本：`picking-ui-smoke` / `order-profit-ui-smoke` / `today-ui-smoke` / `goods-ui-smoke` / `shipping-rate-ui-smoke`（岛侧冒烟一律照抄这段 `waitFor`）。

**取证**：上列 5 个脚本名。

**源**：`2026-09-30-headless-smoke-waitfor-trap`（2026-09-30）

---

## 12. 固定开销不要放进有墙钟预算的 `it` 里

**结论**：扫描型守卫（把整棵源码树读进内存 + 逐字符处理）的耗时是**固定开销**，与用例逻辑无关。只要这段开销写在 `it` 回调里，`testTimeout` 就会把它算进去 ⇒ **报出来的是 `Test timed out`，看起来却像"守卫失败"**。正确做法：把这笔固定开销移到 `describe` 体里（**收集期**执行，不受 `testTimeout` 管），`it` 里只留断言。**加时只是缓解，移出去才是根治。**

**取证**（`tests/uxEntryNames.spec.ts`）：

- 该用例要 `walk(ROOT/src)` 再 `stripComments` 每个文件，是纯 I/O + CPU 的固定开销。
- 实测 2026-10-03：**单跑 2.9 s**（绿）；**全量并发**时被同机的 `tests/publishGuard.spec.ts`（4 个 fork 子进程 × 约 17 s 打包）挤到 **> 20 s**，报 `Test timed out in 20000ms`。⚠️ 这个坑本项目**踩过两次**：第一次（2026-10-01）是把 timeout 从默认 5 s 调到 20 s，第二次（本轮）20 s 也不够 —— 说明"调大数字"这条路本身是错的。
- 改法：`const samples = […]` 的扫描循环从 `it` 移入 `describe` 体；断言一字未改。改后 `it` 内耗时 **288 ms**（原 2.9 s）。

**源**：`2026-10-03-fixed-cost-outside-timed-test`（2026-10-03）

---

## 13. 变异复核：移出去后守卫仍有效

**结论**：**变异复核**（确认移出去后守卫仍有效）：把 `src/core/plugin/host.ts` 一句文案里的「无忧物流运费」改成不存在的「运费测算」→ 守卫红，且报出 `src/core/plugin/host.ts: 「运费测算」`；随后复原。

**取证**：报错原文 `src/core/plugin/host.ts: 「运费测算」`。

**源**：`2026-10-03-fixed-cost-outside-timed-test`（2026-10-03）

---

## 14. 推广判据：单跑绿 / 全量红报 `Test timed out` 的两行诊断表

**结论**：推广到其他用例的判据与改法：

| 症状 | 判据 | 改法 |
| --- | --- | --- |
| 单跑绿、全量红，报 `Test timed out` | `it` 里是否有一次性的大块 I/O / 全树扫描 / 起子进程 | 移进 `describe` 体（收集期）或 `beforeAll` |
| 用例断言本身很快 | 用 `vitest --reporter=verbose` 看单条耗时 | 若单条 < 1 s 却超时 ⇒ 是**被同机其他用例挤**，不是这条慢 |

关联纪律（本项目已有）：**fork 子进程的用例要给 `it` 显式 timeout**；本条的补充是：**固定 I/O 开销不该靠 timeout 兜底**。

**取证**：`vitest --reporter=verbose` 看单条耗时。

**源**：`2026-10-03-fixed-cost-outside-timed-test`（2026-10-03）

---

## 15. 「共享实现被覆盖」≠「调用点被覆盖」

**结论**：把一段逻辑**抽成共享函数**、并给那个函数写了冒烟，**不等于**用它的 handler 被测了。本项目 2026-10-05 的实例：`purchase-export-excel`（拿货单带图导出）在 `scripts/` 下**没有任何脚本 require 过 `purchase-handlers`** —— 它当时带着与拣货单**同一个** exceljs `extension` 真 bug，而 `picking:xlsx:smoke` 只覆盖了修好之后抽出来的那个共享函数 `xlsx-image.embedCellImage`。

**取证**：`scripts/` 下没有任何脚本 require 过 `purchase-handlers`。

**源**：`2026-10-05-handler-call-site-smoke`（2026-10-05）

---

## 16. 调用点独有的东西，只有调用点能验

**结论**：调用点独有的东西，只有调用点能验：

| 只在调用点可见 | 具体到这轮 |
| --- | --- |
| 行映射 / 字段长度约束 | `it.styleCode` / `styleName` / `color` / `size` / `qty` / `priceCents` |
| 业务口径 | `单价 = priceCents/100`、`金额 = 数量 × 单价`、`priceCents===0` 与 `qty===0` **留空**（不是 0.00） |
| 何时去查图 | 只在 **款编码 且 款色** 都非空时；空款色照常导表、只是没图 |
| 分支护栏 | 取消保存 → 一个字节都不写；`items` 超 500 截前 500；洗完没行 → `没有可导出的行` |
| 传图源的方式 | `{ filePath }` 还是 `{ base64 }`（决定媒体扩展名是 png 还是 jpeg） |

**取证**：上表即 `purchase-export-excel` 的调用点专属项。

**源**：`2026-10-05-handler-call-site-smoke`（2026-10-05）

---

## 17. 做法：真 Electron 里截获真 handler（新增 `purchase-xlsx-smoke.cjs`，26 项）

**结论**：新增 `scripts/purchase-xlsx-smoke.cjs`（`npm run purchase:xlsx:smoke`，26 项）。沿用 `scripts/preload-ipc-shape-smoke.cjs` 的范式，**只换四件**，其余保持真实：

```js
const realElectron = require('electron');
const fakeElectron = new Proxy(realElectron, {
  get(t, p) {
    if (p === 'ipcMain') return { handle: (c, fn) => handlers.set(c, fn), /* … */ };
    if (p === 'dialog') return { showSaveDialog: async (...) => /* 可控路径 / canceled */ };
    if (p === 'BrowserWindow') return { getFocusedWindow: () => null, getAllWindows: () => [] };
    if (p === 'app') return { getPath: () => tmpDir };
    return t[p];
  },
});
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, [request, ...rest]);
};
require(path.join(ROOT, 'dist', 'electron', 'purchase-handlers.js')); // 注册进 fakeIpcMain
```

三个要点：

1. **必须真 Electron**：require 链里有 `better-sqlite3`（Electron ABI）。沙箱里 `ELECTRON_RUN_AS_NODE=1` 常驻 ⇒ `env -u ELECTRON_RUN_AS_NODE` 去掉再跑，否则 `require('electron')` 只返回一个字符串路径，报的是不知所云的 `Cannot read properties of undefined (reading 'handle')`。脚本开头有早退护栏直接说明跑法。
2. **只 stub 依赖的"叶子"**：`order-db.findStyleColorImagePath` 换成可控映射即可 —— handler 里是 `const orderDb = require('./order-db')`，拿的是**同一个 exports 对象**，改属性即生效（不必碰 `require.cache`）。素材用**真图**（`build/icon.png`）：造假文件会让"按原始比例算显示高度"永远测不到。
3. **"取消"要断言"没多出文件"**，不是断言某一条路径不存在 —— 后者挡不住"取消后写到某个默认路径"这类 bug。写成：输出目录里 `.xlsx` 数量为 0。

**取证**：

```bash
npm run purchase:xlsx:smoke     # 26 项；改过 electron/*.ts 后脚本自带 tsc
grep -rn MUTANT src/ scripts/ tests/ electron/   # 收工必须为空
```

- 脚本：`scripts/purchase-xlsx-smoke.cjs`；npm script 在 `package.json` 的 `purchase:xlsx:smoke`
- 被验的 handler：`electron/purchase-handlers.ts:303` 的 `register('purchase-export-excel', …)`
- 共享实现与它的坑：`electron/xlsx-image.ts`（文件头）、`docs/notes/2026-10-30-picking-and-takeout.md`
- 基线登记：`docs/baseline/PROJECT_BASELINE.md` 的冒烟总表新增一行

**源**：`2026-10-05-handler-call-site-smoke`（2026-10-05）

---

## 18. 变异补丁要打在真正的守卫点 —— 7 组里有一组第一次没变红

**结论**：变异复核 **7 组**，都逐组确认变红后复原：价格留空 · qty=0 金额留空 · 过滤条件（只认款编码）· 500 上限 · 取消分支（含"写到默认路径"）· `extension` 缺失 · 单张坏图不再被吞。

⚠️ **其中一组第一次没变红**：把 `sniffImageFormat` 结果的 `return null` 改成 `throw` —— 冒烟照绿。因为那个 `throw` 就在**外层 `try/catch` 里面**，被自己吞掉了（`return null` 才是最终行为）。改打在**真守卫点**（`return null` + 外层 `catch { return null }` 同时拆掉）之后才红。这印证了老规矩：**变异补丁要打在真正的守卫点，否则"没变红"什么都不能证明**。

**取证**：见上；`grep -rn MUTANT src/ scripts/ tests/ electron/` 收工必须为空。

**源**：`2026-10-05-handler-call-site-smoke`（2026-10-05）

---

## 19. 渲染期崩溃的表现是「元素消失」而非报错 —— 抓它的姿势就是断言「元素还在」

**背景**：2026-10-17 拿货页 UI 评审（原文 `UI_REVIEW_PURCHASE_2026-10-17.md`，2026-10-30 归档时本节并入）修「空行金额显示 —」时引入的 `rowAmountText` 直接调 `r.priceText.trim()`，被截图脚本的填行阶段当场打崩。

- **根因**：`pue-price` 是 `<input type="number">`，其 `v-model` 会把用户输入 **coerce 成 number**（变异实测确认，不是 string）。`priceText` 类型虽声明 `string`，运行期敲价后是 number ⇒ `.trim()` 抛 `TypeError: e.priceText.trim is not a function`。
- **症状隐蔽**：崩在**渲染期**，不走 `window.onerror`，只有 `console.error`；Vue 把整个编辑器组件卸载 ⇒ 现象是「一敲单价抽屉自己消失」，无任何报错浮出（`errs:[]`、`close()` 未被调用、无 `purchaseOrderUpdate`——三个方向都排空后才靠覆盖 `console.error` 逮到）。
- **修法**：`String(r.priceText ?? '').trim()` 防御式包一层（`rowCents` 本就用 `Number()` 吃两种，别处无此坑）。
- **守卫**：`scripts/today-ui-smoke.mjs` 新增「敲单价：编辑器不崩」断言（往 `pue-price-1` 敲 25.5 ⇒ 断言编辑器仍在 + 金额格实时重算 ¥76.50）。**变异验证**：还原崩溃版重构建 ⇒ 该断言精确变红（`editor-unmounted`）且后续步骤连锁失败；还原修复版 ⇒ 回绿。
- **方法论**：对"元素在不在"类冒烟，渲染期崩溃只会表现为"元素消失"，断"元素在"恰好是唯一抓得住它的姿势；而合成事件脚本（`el.value=` + `dispatchEvent`）与真实输入同路径，能复现真实用户敲键的后果。
- **定位次序（排除法，可复用）**：先 IDLE-CHECK 排除"放着就坏"→ 拦 `keydown`/`click` 排除误触 → 拦 `Node.removeChild` 抓卸载栈（确认是 Vue 主动卸载）→ `window.__smokeCalls` 排除保存路径（`upd:0`）→ 源码 `close()` 埋栈排除主动关闭（`cp:null`）→ 最后覆盖 `console.error` 逮到渲染崩溃。每一步都把一个假设钉死，剩到最后一个解释为止。

同次评审的 P0 是「复制清单图」**假动作**：`copyingId` 判等写成恒真，卡片永远停在「生成中…」——判据见 `2026-10-30-ui-style-and-hierarchy`（"假动作"行）。

**源**：`UI_REVIEW_PURCHASE_2026-10-17`（2026-10-17，原评审文档已归档）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-09-30-copy-guard-layer.md` | 2026-09-30 | §1 / §2 / §3 / §4 / §5 / §6 |
| `2026-09-30-headless-smoke-waitfor-trap.md` | 2026-09-30 | §7 / §8 / §9 / §10 / §11 |
| `2026-10-03-fixed-cost-outside-timed-test.md` | 2026-10-03 | §12 / §13 / §14 |
| `2026-10-05-handler-call-site-smoke.md` | 2026-10-05 | §15 / §16 / §17 / §18 |

**关联索引（原笔记自带，未并入正文）**

- 技能 `esm-spa-headless-smoke`（file:// 被 CORS 拦、stale 节点、表单值不在 textContent 里）、`docs/architecture/UI_ISLAND_INTAKE_CHECKLIST.md` §2（岛侧同类检查项）—— 源自 `2026-09-30-headless-smoke-waitfor-trap`。
