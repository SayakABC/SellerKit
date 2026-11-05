# 安全与性能整改计划（2026-11-04）

> 来源：2026-11-04 代码审查（未改动任何代码）。本文件**只定方案与验收**，实施另开提交。
> 审查结论的取证全部是 `文件:行`，命令可直接复跑。
> **施工状态（2026-11-04）**：S0 / S1 / S2 / S3 已落地并通过全部门禁，S4 经用户决定推迟；
> 落地过程中被实测推翻的两处假设（P1 的性能量级、`frame-src` 能否拦自定义协议）已就地改写，
> 详见 §1.2 与 §5。进度总账在 §8。

---

## 0. 一页结论

1. **唯一"现在就能被利用"的问题是链条式越权**：市场分发的 UI 岛 → 宿主渲染层任意 JS 执行 → 拿到 `window.electronAPI` 全量能力 → 经 `net-request` 外带数据。这条链与数据量无关，装上恶意岛即成立，**必须先修**。→ 已修（S0，见 §8）。
2. **规则求值的性能问题也是真的**：`new Function` 落在**单元格**粒度，导入 5 万行 × N 规则 = 百万级编译，界面锁死。它与库大小无关（瓶颈在导入路径），一并修。
   → 已修；但**实测后性能量级要下修**：V8 对同源 `new Function` 有编译缓存，4 万格只差 6 ms（§1.2）。这条的真实价值是顺带删掉了"单元格级求值发生在持 `electronAPI` 的窗口里"。
3. **数据库类性能问题属潜伏**：当前真库 `oi_order_items` 只有 5 行（取证见 §1.3），现在做索引/FTS/虚拟滚动没有可测收益。**不提前优化**，改为"给定触发阈值 + 基准脚本"，触发了再做。→ 只做了三条零风险项（S3）。
4. 分发签名（Windows 无签名、`hardenedRuntime: false`）需要证书与发布流程配合，单列为待拍板，不进本轮施工。

**顺序理由**：先把 `eval` 从主窗口搬走（S0），主窗口才可能收紧 CSP（S1）；CSP 收紧后，即便将来又出现注入点，也不会立刻变成"读全库 + 外带"。反过来先加 CSP 会直接打断 `jsExpression` 功能（它是岛设置页的正式能力），属于"先砸功能再补洞"。

---

## 1. 问题清单与判定

### 1.1 P0 · 插件越权执行（越权面 = 宿主渲染层全部能力）

| 环节 | 位置 | 事实 |
| --- | --- | --- |
| 发放 | `src/core/plugin/sanitizeExcel.ts:22` | `EC_RULE_TYPES` 含 `jsExpression`，`config.code` 只截断长度（20000 字符），**不限内容** |
| 转交 | `src/core/plugin/host.ts:87-96` | `applyRules` 把插件载荷直接交给 `applyFieldProcessor` |
| 执行 | `src/lib/fieldProcessor.ts:60,342` | `new Function('fields', ...)` 在**主窗口**求值 |
| 放大 | `index.html`（无 meta CSP）、`electron/*.ts`（无 `onHeadersReceived`） | 主窗口**没有任何 CSP**，`eval`/`new Function` 畅通 |
| 外带 | `electron/ipc-handlers.ts:13` | `net-request` 只校验字段类型与长度，**不限制目标域名** |
| 连带 | `src/core/network/token.ts:6` | Bearer token 存 `localStorage`，同源脚本可读 |

`fieldProcessor.ts:340` 注释里的"安全沙箱：冻结 fields 副本"是**无效描述**：`Object.freeze` 只锁那份副本，代码仍可触达 `window` / `fetch` / `window.electronAPI`。

**复现判据（实施前先跑一遍，作为"改前必红"）**：装任一声明了 `db` 能力的岛，调用
`applyRules` 并传 `{ type:'jsExpression', config:{ code:'typeof window.electronAPI' } }`
⇒ 返回 `"object"`。修复后同一条必须返回空/报错，且该岛无法再触达 `electronAPI`。

### 1.2 P1 · 规则求值按单元格编译

`src/lib/fieldProcessor.ts:53-77` 的行循环里，每条规则对**每一行**调用一次 `processJsExpression`，
其内部每次都重新 `new Function`。上限 `EC_MAX_RECORDS = 50000` × `EC_MAX_RULES = 64`
⇒ 最坏 320 万次编译。`processMath` 同样每格重新 tokenize + 建 AST。

**复现判据**：`tests/fieldProcessor.spec.ts` 增加 5000 行 × 8 条 `jsExpression` 用例并计时，记录基线（预计 > 2s）。

**实测修正（2026-11-04，改后回测）**：原判「320 万次编译 ⇒ 秒级卡顿」**高估了**。
V8 对**同源** `new Function` 命中编译缓存，逐单元格编译一段**不变**的规则体只摊到约 0.14µs：

```
同源 4 万次 new Function : 5.5 ms      ← 逐单元格编译同一段规则体的真实开销
异源 4 万次 new Function : 24.2 ms     ← 强制真编译（源码逐次不同）才是"每次都在编译"
```

5000 行 × 8 规则（4 万格）实测：逐单元格 **7.1 ms** → 每规则一次 **0.9 ms**（6.2 ms 差价，7.9× 比值但基数太小）。
⇒ **S2 的性能收益是"毫秒级"，不是 P1 量级**；这条真正值钱的是它顺手删掉了
「单元格级 `new Function` 出现在持 `electronAPI` 的窗口里」这个可执行面（P0 的另一半）。
本文件把 S2 的定位从「性能修复」改成「隔离改造的附带收益」，性能数字照实记在 §8。

### 1.3 P2 · 数据库与查询（潜伏，暂不动）

| 项 | 位置 | 现状 |
| --- | --- | --- |
| PRAGMA 不全 | `electron/db.ts:39-40` | 只设了 `journal_mode = WAL` + `foreign_keys`；无 `synchronous` / `cache_size` / `busy_timeout` |
| 语句无缓存 | `electron/db.ts:166-195` | 每次 `prepare` 后即弃；`dbTransaction` 已存在但语句未复用 |
| 循环内 prepare | `electron/order-db.ts:1861,2041,2391` | `while (d.prepare(...).get(scCode))` 每轮编译一次 |
| 8 列前缀通配 | `electron/order-db.ts:4520-4560` | `LIKE '%kw%'` × 8 列 + 2 LEFT JOIN，且每页再跑一次 `COUNT(*)` |
| 大 page size | `electron/order-db.ts:4506` | 单页上限 2000 行，前端无虚拟滚动 |

**真库规模取证（2026-11-04 实测）**：

```bash
sqlite3 "file:$HOME/Library/Application Support/seller-kit/sellerkit.db?mode=ro" \
  "select 'oi_order_items',count(*) from oi_order_items
   union all select 'oi_orders',count(*) from oi_orders
   union all select 'pl_products',count(*) from pl_products;"
# oi_order_items|5 / oi_orders|5 / pl_products|21
```

⇒ 上述四项在 5 行数据上**测不出差异**，本轮只做"零风险且可逆"的那几条（见 S3）。

---

## 2. 目标边界（求值隔离）

```
UI 岛（iframe，CSP script-src 'self'，无 unsafe-eval）
   │  db.call('excel-copy','applyRules', {records, rules})
   ▼
宿主渲染层（主窗口）—— 只做消毒/编排，不再求值
   │  rule-eval:batch（IPC，分批 500 行）
   ▼
求值窗口（隐藏 BrowserWindow）
   webPreferences: contextIsolation:true, nodeIntegration:false, sandbox:true, 无 preload
   文档自带 CSP: default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'
   ▼
返回结果数组 → 主窗口 → 岛
```

三条不变量（缺一条就等于没修）：

1. 求值窗口**不持任何 Electron 能力**：无 preload、`nodeIntegration:false`、`sandbox:true`
   ⇒ 窗口内 `window.electronAPI === undefined`。
2. 求值窗口**不能出网**：`connect-src 'none'`，`default-src 'none'` ⇒ `fetch` 必失败。
3. 主窗口**不再允许 eval**：`script-src 'self'`（S1 完成后生效）。

为什么不是"自写 AST 求值器"：现有规则里已出现 `fields["DNS"].split('.').slice(0, 1)[0]`
（成员访问 + 方法链 + 下标），自写求值器要覆盖这套子集才能不破功能，成本高于一个隔离窗口，
且以后每加一种语法都要改两处。AST 方案作为备选，触发条件见 §7 D-1。

---

## 3. 阶段计划

### S0 · 规则求值隔离（P0，约 1–2 天）

| 任务 | 落点 | 要点 |
| --- | --- | --- |
| T0-1 求值窗口 | 新建 rule-eval-window.ts 与静态页 rule-eval.html（均放 `electron/`；静态页同 `electron/plugin-ui-runtime.js` 的先例，在 `electron-builder.yml` 的 `files` 显式收录） | 单实例惰性创建；空闲 60s 销毁；每次请求带 `requestId` + 2000ms 超时（防 `while(true)` 卡死，超时即 `webContents.forcefullyCrashRenderer` 并重建） |
| T0-2 求值协议 | `electron/preload` 不放行；新通道 `rule-eval-batch`（`electron/ipc-util.ts` 的 `handle` 注册） | 入参：`{ rules, records, headers }`，逐条按 `EC_MAX_RULES` / `EC_MAX_RECORDS` 复核（不信任渲染层已消毒） |
| T0-3 编译一次 | 求值页内：`Map<ruleId, fn>` 先把每条 `jsExpression` 编译一次，再逐行调用 | 与 T0-4 是两件事：**编译粒度**修的是 CPU，**窗口隔离**修的是能力 |
| T0-4 调用点改异步 | `src/lib/fieldProcessor.ts` 拆成 `applyFieldProcessorLocal`（math/template/dateOffset，纯本地）+ `applyFieldProcessor`（async，含 jsExpression 时走 IPC）；`src/core/plugin/host.ts:96` 加 `await` | 生产调用点只有这一处（`grep -rn applyFieldProcessor src/`），改动面极小 |
| T0-5 分批 | 主窗口侧按 500 行/批调用 | 避免单次 IPC 载荷过大（`payloadBudget.ts` 已有规模约束的先例） |
| T0-6 冒烟 | 新增 rule-eval-smoke.cjs（放 `scripts/`）+ `package.json` 脚本 | 三类断言：① 合法表达式结果与旧实现逐条一致（夹具含默认规则 `fields["DNS"].split('.').slice(0,1)[0]`）② 窗口内 `typeof window.electronAPI === 'undefined'` ③ 窗口内 `fetch('http://127.0.0.1:1')` 必须 reject |

**风险**：新窗口的生命周期（`app.quit` 时未销毁会拖住退出）⇒ 在 `before-quit` 里统一 `destroy()`。

**回滚**：`applyFieldProcessor` 保留本地实现分支（环境变量 `RULE_EVAL_LOCAL=1`），窗口起不来时回落，
但**回落必须打 WARN 并在 IPC 返回里标注** —— 静默回落等于洞又回来了。

### S1 · 主窗口 CSP（P0 收口，约 0.5 天）

前置：S0 T0-4 完成（主窗口不再有 `new Function`）。

| 任务 | 落点 | 要点 |
| --- | --- | --- |
| T1-1 加 meta CSP | `index.html` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://localhost:5173 http://localhost:5173; frame-src sk-plugin: sk-mail:; object-src 'none'; base-uri 'none'` |
| T1-2 生产二次加固 | `electron/main.ts` 的 `createWindow` 之后，对 `file://` 响应补 `onHeadersReceived` | meta 已覆盖大部分；此项为纵深，若 meta 在 `file://` 下 `'self'` 匹配异常则该窗口仍受 meta 约束 |
| T1-3 验证 | `npm run build` 后跑 `esm-spa-headless-smoke` 技能（无头 Chrome 过一遍主界面） | 必须验证：① 首屏能进 ② 岛能加载 ③ 邮件正文能渲染（`sk-mail:` 在 `frame-src` 里）④ dev 下 HMR 仍通 |

**风险**：`file://` 下 `'self'` 的匹配行为在不同 Electron 版本上有差异 ⇒ 必须先跑 T1-3 的 ② ③，
任何一项红即回滚 meta（一行删除），并把窗口隔离(S0)作为唯一防线。

**回滚**：删 meta 一行；无数据风险。

### S2 · 导入期 CPU（P1，约 0.5 天）

**已落地**：编译粒度改「每规则一次」——求值页里按**规则代码**缓存编译结果（不是按规则 id：
改规则时 id 不变而代码变了，按 id 缓存会拿到旧函数；这个错在 `rule-eval:smoke` 的首轮实测中就被抓到过）。

- `processMath` 缓存 tokenize + AST：**实测后决定不做**。5000 格 4.0 ms / 20000 格 9.2 ms（≈0.4µs/格），
  缓存最多省一半 ⇒ 每 2 万格省 5 ms，却要把 `${var}` 占位符的 tokenize/求值拆成两段（负数、小数、
  运算优先级都在里面）。同一笔时间预算里，这个改动**风险大于收益**。
- `processTemplateConcat` 缓存分段结果：同理不做（一次 `String.replace` 带回调，省不出可测量时间）。
- **判据修正**：原目标「≥ 5× 提升」已不适用（见 §1.2 实测修正）。实际记录见 §8。

### S3 · 数据库卫生（P2，触发式，约 0.5 天）

**只做零风险且可逆的三条**，其余等触发：

| 任务 | 落点 | 判据 |
| --- | --- | --- |
| T3-1 PRAGMA 补齐 | `electron/db.ts:39` | 加 `synchronous = NORMAL`、`cache_size = -20000`、`busy_timeout = 5000`；`vitest run` 全绿（若有用例依赖 durability 语义会在这里红） |
| T3-2 语句缓存 | `electron/db.ts:166-195` | `Map<sql, Statement>`；**`closeDb()` 必须清空缓存**（备份/恢复会先 close，不清就是 use-after-close） |
| T3-3 循环内 prepare 外提 | `electron/order-db.ts:1861,2041,2391` | 三处同样的 `while` 写法，把 `prepare` 提到循环外；行为不变，靠 `npm run order:smoke` 兜 |

**触发阈值（写在代码注释里，别只写在文档里）**：
- 任一表 > 5 万行 → 做 T3-4（`LIKE` 改 FTS5，抄 `electron/mail-db.ts` 的 `FTS_TABLE` 范式）
- 单页返回 > 500 行 → 做虚拟滚动（先确认既有 UI 冒烟选择器不依赖"全量 DOM 存在"）

**已落地（2026-11-04）**：

- T3-1 / T3-2 落在 `electron/db.ts`：三个 PRAGMA 进 `initDb()`；`stmt(sql)` 缓存放在
  `dbQuery/dbGet/dbRun` 下面（`dbTransaction` 不动 —— 每次包的都是不同的 `fn`，缓存不了）。
  缓存上限 512 条（SQL 全是代码字面量，实际达不到；少数按列名/字段组合拼装的也远小于这个数）。
- **失效是两道**：`closeDb()` 清空 + `stmt()` 比对连接身份（`stmtCacheDb !== d`）。
  只留一道也能过 —— 所以做了变异验证：两道一起拆掉，`schema:smoke` 立刻多行报
  `The database connection is not open`（不是"看不见的隐患"）。
- T3-3 三处 `while` 的探测语句全部外提（`ensureStyleColor` / `assignOrderStyle` / `importStyles` 各一处）。
- 门禁实测：`tsc` ✅ · `order:smoke` 99/99 ✅ · `db:inventory` ✅ · `schema:smoke` ✅ ·
  `picking:smoke` ✅ · `vitest run` 74 文件 / 1440 项 ✅。

> ⚠️ **跑这些冒烟必须剥掉继承来的 `ELECTRON_RUN_AS_NODE=1`**，否则 `require('electron')` 只是个字符串，
> 任何走到 `app.getPath()` 的分支都会抛 `Cannot read properties of undefined (reading 'getPath')`。
> 本机 `npm run order:smoke` 就因此报过一项假失败（`投影层与归类口径同一份` —— 它经
> `pickingRows → resolveImagePath → IMAGE_DIR() → app.getPath('userData')`）。
> 真实跑法：`env -u ELECTRON_RUN_AS_NODE npx electron --no-sandbox --disable-gpu scripts/order-db-smoke.cjs`。

### S4 · 分发与凭据（P3，需拍板，不进本轮）

- `electron-builder.yml:44`（`hardenedRuntime: false`）与 `electron-builder.yml:68`（publish 无 `publisherName`）、
  `electron/updater.ts:120`（GitHub Releases 更新源）⇒ Windows 侧更新包**无签名校验**，账号被盗即全量投毒。
- `src/core/network/token.ts:6` ⇒ 迁到主进程 `safeStorage`（同 `electron/shop-secrets.ts` 的 `E`/`P` 标记法）。

---

## 4. 门禁矩阵

| 阶段 | 必跑 | 说明 |
| --- | --- | --- |
| S0 | `tsc -p tsconfig.electron.json` → `vue-tsc --noEmit` → `npm run verify` → `npm run rule-eval:smoke` → `vitest run` | 主进程先 `tsc`，否则跑的是旧产物 |
| S1 | `npm run build` → 无头冒烟（主界面/岛/邮件正文）→ `npm run plugins:island:smoke` | CSP 破坏的是"加载"，只有真跑才能发现 |
| S2 | `vitest run`（计时用例） | 计时阈值别卡太死，防 CI 抖动误报 |
| S3 | `npm run order:smoke` / `npm run db:inventory` / `vitest run` | 语句缓存要额外跑一次"备份→恢复"路径（会触发 `closeDb`） |
| 全程 | `npm run verify:docs` | 本文件与索引必须同步，否则文档门禁红 |

---

## 5. 变异清单（证明新守卫不是恒绿）

每条都要"改坏 → 断言必须变红 → 改回"。**下表是实跑记录，不是计划**：

| # | 变异 | 结果 |
| --- | --- | --- |
| 1 | 求值窗口的 `preload` 换成主 `preload.js` | ✅ 7 项全红。主 preload 不提供 `__ruleEvalBridge` ⇒ 批次永不返回 ⇒ 全部超时；`window.electronAPI` 那条也在其中 |
| 2a | 只去掉求值页 CSP 的 `connect-src 'none'` | ⚠️ **仍绿**。`default-src 'none'` 还兜着 —— 是冗余防御，不是恒绿；单拆一条测不出东西 |
| 2b | 同时去掉 `default-src` 与 `connect-src` | ✅ 精准变红：`CSP 未拦截出网请求（cspViolations=0）` |
| 3 | `applyRules` 里 `sanitizeRules(p?.rules)` → 原样透传 | ❌ **改前 1440 项全绿**（真缺口：净化函数自己有整套用例，调用点无人管）。已补 `tests/pluginTriage.spec.ts` 的接线守卫，复验变红 |
| 4 | 语句缓存不在 `closeDb` 清空 + `stmt()` 不比对连接身份 | ✅ `schema:smoke` 多行报 `The database connection is not open` |
| 5 | 编译缓存键从 `rule.code` 改成 `rule.id` | ✅ 开发期就被 `rule-eval:smoke` 的 parity 用例抓到（7 条夹具共用 id，第 2 条起拿到上一条的函数） |

> 第 5 条的原始计划是「改回逐行编译 ⇒ 计时用例必须超阈值」。实测后作废：
> V8 对同源 `new Function` 有编译缓存，逐格与逐规则只差 6 ms/4 万格（§1.2），
> 计时断言在这个量级上只会抖动误报。换成"缓存键写错"这种**语义**变异才真有判别力。

---

## 6. 明确不做（本轮）

- **不重写规则引擎为自写 AST 求值器**：会牺牲现有 `jsExpression` 语法兼容，且成本高于隔离窗口。
- **不动 `PLUGIN_ARCHITECTURE` 的权限模型**：岛声明 `db` 能力本身合法，问题在宿主把能力借了出去，不在权限清单。
- **不为 5 行数据做索引 / FTS5 / 分页改造**：没有可测收益，属提前优化。
- **不把 `user-file-allowlist` 扩展成全盘读**：现状是"对话框选过才放行"，这条是对的，别为了省事放宽。

---

## 7. 待拍板

| ID | 问题 | 建议 |
| --- | --- | --- |
| D-1 | 求值隔离用「隐藏窗口」还是「自写 AST 求值器」 | 隐藏窗口：语法 100% 兼容、可回滚；AST 留作备选 |
| D-2 | dev 环境 CSP 是否也收紧 | 建议收紧（保留 `ws://localhost:5173`），否则 dev 与打包版行为不一致，问题只在发布后才暴露 |
| D-3 | `net-request` 是否加域名白名单 | 建议**本轮不做**：岛侧已有 `connect-src 'self'`，主窗口 CSP 收紧后这条链已断；白名单会误伤用户可配置的 AI/市场地址 |
| D-4 | 更新签名是否本轮做 | 需 Windows 证书 + 发布流程改造，建议单独排期 |

---

## 8. 进度跟踪

| 阶段 | 任务 | 状态 | 验收记录（实跑） |
| --- | --- | --- | --- |
| S0 | T0-1 ~ T0-6 求值隔离 | ✅ 已落地 | `electron/rule-eval-window.ts` + `rule-eval-preload.ts` + `rule-eval-batch` 通道；`fieldProcessor` 改为规则外层 / 记录内层批量。`rule-eval:smoke` 9/9（含 `electronAPI === undefined`、`require/process` 不可达、fetch 被 CSP 拦、单行报错隔离、死循环超时后窗口可复用、超长 code / 超大批次被拒） |
| S1 | T1-1 ~ T1-3 主窗口 CSP | ✅ 已落地 | `index.html` 加 meta CSP（`script-src 'self'` 无 `unsafe-eval`）；内联主题脚本外移 `public/theme-init.js`。`csp:smoke` 6/6（真产物 + 真 preload：`eval` 抛 `EvalError`、主题已应用、CSP meta 在、`sk-plugin://` iframe 能加载） |
| S2 | 编译粒度 | ✅ 已落地（定位修正） | 缓存键 = 规则代码，每规则只编译一次。**实测 4 万格 7.1 ms → 0.9 ms**；`processMath` / `templateConcat` 实测后明确不做（§S2）。真正价值在 P0 隔离，不在速度 |
| S3 | T3-1 ~ T3-3 数据库卫生 | ✅ 已落地 | `order:smoke` 99/99 · `schema:smoke` ✅ · `picking:smoke` ✅ · `db:inventory` ✅ · `vitest run` 74 文件 / 1440 项 ✅ · 失效逻辑经变异验证（§5 #4） |
| 全程 | 静态门禁 | ✅ | `tsc -p tsconfig.electron.json` · `vue-tsc --noEmit` · `npm run verify`（32 项）· `check-ipc-contract`（265 键 / 265 类型 / 260 主进程通道）· `npm run build` |
| S4 | 签名 / token | ⬜ 待拍板（D-4） | 用户明示本轮推迟 |

> **本机跑冒烟的前提**：`ELECTRON_RUN_AS_NODE=1` 会被继承进来，`require('electron')` 变成字符串，
> 任何走 `app.getPath()` 的路径都抛 `Cannot read properties of undefined (reading 'getPath')`。
> 一律 `env -u ELECTRON_RUN_AS_NODE npx electron --no-sandbox --disable-gpu scripts/<x>.cjs`；
> 用 `npm run <x>:smoke` 也行，但它会先跑 `tsc`（做变异测试时正好会把改动覆盖掉，要绕开）。
