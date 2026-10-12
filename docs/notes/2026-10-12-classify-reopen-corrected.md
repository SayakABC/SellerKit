# 「退回待核对」：把单向的能力补成双向，以及「已核对的行去哪了」

日期：2026-10-12（承接 2026-10-11 第五轮 `2026-10-11-classify-color-not-effective.md`）

用户原话（在上一轮结论报告末尾的 A/B 二选一中）：

> 做B

A = 直接改真库把 23 行 `corrected` 置回 0（一次性、不可逆、用户看不出改了什么）；
**B = 新增「退回待核对」动作**（把已核对的行放回待核对列表重做）。

两条交互口径在动手前用选项拍定：

- **入口形态 = 页头范围切换**（把原只读的那条计数变成可点的两个范围）；
- **批量 = 只做逐行**，**不做「全部退回」**。

## 结论：这个页面前是"单向阀"——完成的行再也回不来

「发货台 › 归类核对」的待核对表按定义只查 `corrected = 0` 的行：

```ts
// src/modules/today/classify.ts（改前）
listPending(opts) → ipc.orderList({ corrected: false, … })   // 只要待核对
```

而写 `corrected` 的两条路径**都只写 1**：

| 路径 | 行为 |
| --- | --- |
| `orderUpdate`（「保存」） | 顺手把该行 `corrected = 1` |
| `orderMarkCorrected`（「确认无误」/「全部确认无误」） | 把点名的行 / 全表置 1 |

⇒ **两条路都是单向的**。全仓 grep 不到任何一处会把 `corrected` 写回 `0`。于是：

- 已核对的行**有任何屏幕能看见**（它按定义不在待核对列表里）；
- 用户核对完一轮、发现某行颜色/款选错了 —— **没有任何入口能回去改**；
- 真库现场（2026-10-11 夜）：`oi_orders` 23 行**全部** `corrected = 1`（当天导的 23 行都被"确认无误"过了）。

这是一个纯粹的**能力缺口**，不是 bug。上一轮修完「设颜色不生效」之后，用户核对过的行才真的写对了数据；
紧接着就撞上"写错了也回不去"。两件事恰好在同一条链上前后脚暴露。

## 落地：页头范围切换 + 行内「退回待核对」

### ① 数据层：只翻 `corrected` 这一位

`electron/order-db.ts` 新增 `reopenOrdersCorrected(ids)`：

```ts
export function reopenOrdersCorrected(ids: number[]): number {
  const list = [...new Set(ids)].filter((n): n is number => Number.isInteger(n) && n > 0);
  if (!list.length) return 0;
  const d = getDb();
  const placeholders = list.map(() => '?').join(',');
  const r = d
    .prepare(`UPDATE oi_orders SET corrected = 0 WHERE id IN (${placeholders})`)
    .run(...list);
  return Number(r.changes);
}
```

三条刻意的设计：

1. **只翻 `corrected` 一位** —— 不碰 `category` / `color` / `logo`。退回是"我要重做"，不是"把你之前的判断抹掉"；
   重做时用户手里的草稿还在，改完再保存一次即可。
2. **刻意没有 `all` 分支** —— 一次退回整批是不可逆的（退回后无法区分"本来就没核对"和"我刚退回来的"），
   且用户看不出到底退回了多少行。这与 `markAllOrdersCorrected`（批量置 1）**不对称是有意的**：
   确认可以一键（错了一行还有列表兜底），退回不行。
3. 复用 `markOrdersCorrected` 的入参清洗（去重 / 只留正整数），空列表直接返回 0。

### ② 契约四处同改

| 文件 | 改动 |
| --- | --- |
| `electron/order-db.ts` | `reopenOrdersCorrected(ids)` |
| `electron/order-handlers.ts` | 新通道 `order-reopen-corrected`，payload `{ ids: number[] }`，上限 10000 |
| `electron/preload.ts` | `orderReopenCorrected`（**入参裸数组**，无 `{ all }`） |
| `src/types.ts` | `ElectronAPI` 声明 |
| `src/core/services/ipc.ts` | `ElectronApi` 接口声明 |

⚠️ handler 的校验段与 `order-mark-corrected` **刻意各写一遍、不抽公共函数** ——
两条通道的语义不对称（一条收 `all`、一条只收 ids），抽公共函数会把"它们其实不一样"这件事藏起来。

### ③ 渲染层：`classify.ts` 抽出唯一取数实现

改前 `listPending` 里直接写死 `corrected: false`，改后抽出私有 `listPage(corrected, opts)`：

```ts
function listPage(corrected: boolean, opts: PageOpts) {
  return need(ipc.orderList({ corrected, ...opts }));
}
export function listPending(opts) { return listPage(false, opts); }   // 名字保留
export function listCorrected(opts) { return listPage(true, opts); }  // 新增
export async function reopenCorrected(ids: number[]): Promise<number> { … }
```

`listPending` 的**名字保留**（不叫 `listUncorrected`）是为了让既有的 docs 引用不失效 ——
这次改的是一半能力，不是给函数改名叫别的语义。

### ④ `ClassifyPanel.vue`：页头范围切换

原页头是一条只读计数「待核对 X · 已核对 Y」（上一轮刚做的"动作计数"）。本轮把它变成**两个可点的范围**：

- `.wb-seg` 分段控件（与「货与成本」的「待关联队列 / 已建立映射」同一套基座），
  两个范围各带计数徽标（`cl-count-pending` / `cl-count-corrected`）；
- 切到「已核对」⇒ 列出**今天这批**已核对的行，每行一个「退回待核对」(`cl-reopen-<id>`)；
- 已核对范围的**颜色 / 归属款两格变成只读文本**（`cl-ro-color-<id>` / `cl-ro-style-<id>` —— 没有输入控件可改），
  操作列只有「退回待核对」；
- 「同商品」徽标、说明句、「全部确认无误」按钮**都只在待核对范围出现**；
- 空态按范围分叉：已核对空态给 `cl-goto-pending`（切回待核对），待核对空态给 `cl-goto-corrected`（「看已核对的 N 行」）；
- `setScope()` **回到第 1 页**、保留搜索词 —— 换范围后页码还停在第 3 页会直接看到空表。

⚠️ **两处刻意的守卫**：`applyFocus` / `onRowEnter` 开头都加 `if (scope.value !== 'pending') return;` ——
键盘流（回车保存、焦点落到顶上那一行）只在待核对范围有意义，已核对范围没有可编辑格。

⚠️ **计数与产品库那两份取数不跟着换** —— 只有分页那一份按 `scope` 选 `listCorrected` / `listPending`。
计数条两个数必须**同屏同时可见**（它是"这一轮做了多少"的唯一证据），跟着范围换会变成"切过去才知道有多少"。

## 纪律：退回与确认**互为镜像**

第一版我按直觉写了「退回一行本来就待核对的行 ⇒ 返回 0」，`order:smoke` 当场打红 —— 实测 `changes = 1`。
`UPDATE … SET corrected = 0 WHERE id IN (…)` 命中即算一次，**它不问原来的值是不是 0**。

于是把语义定成一条，并在用例名里写明：

> **退回与确认互为镜像：都按点名的 id 直接写目标值（不额外要求"原状态不是它"）。**

这与 `markOrdersCorrected` 的既有行为**对齐**（它也只按 id 置 1，不校验原来是不是 0）。两条通道
"点谁写谁"是同一条规矩，界面层负责只把该出现的行露出来。把这条写进用例名，是为了让下一个人不用再猜一遍。

## 冒烟：`today:ui` +15，`order:smoke` +6

### `today:ui` 223 → **238**

原「cl-counts」那两条改成 `cl-count-pending === '5'` / `cl-count-corrected === '2'` + 默认停在待核对；
新增整段「已核对范围 + 行内退回」：

- 切范围**列出另一批行**（P-46 / P-47），并**反向守卫**待核对行不许混进来；
- 已核对行**只读无控件**（两个读只读格 `cl-ro-*` 存在、输入控件不存在）+ 只有「退回待核对」一个动作；
- 只读格**两个取值分支**都要覆盖：P-46 **款色「黑」** / 订单色「灰」⇒ 显示**款色「黑」**；
  P-47 **款色空** / 订单色「蓝」⇒ 回落显示**订单色「蓝」**。
  ⚠️ **夹具必须给两个不同的值** —— 两个值相同（比如都写"黑"）时，"款色优先"与"直接读订单色"两种实现**全绿**，
  这条断言就是空转。
- 已核对范围**没有「全部确认无误」**（批量退回刻意不做）+ 说明句跟着范围换；
- 退回载荷恰好 `[46]`（只发 id）；
- 退回后**离开已核对范围**（计数 2 → 1）、切回待核对 **P-46 在**（计数 5 → 6）、退回来的行**可编辑**；
- 已核对**空态**与 `cl-goto-pending` 出口；待核对 5 → 7。

### `order:smoke` 21 → **27**（+6）

宿主侧唯一能验这两条 SQL 的地方，新增 `[6.5] 核对状态（确认无误 / 全部确认 / **退回待核对**）`：

1. 「确认无误」只动点名的那一行（其余行不受影响）
2. `corrected` 过滤**三态**：`false` 只出待核对 / `true` 只出已核对 / **不传 = 不过滤（全表）**
3. ⭐「退回待核对」把它放回待核对，且**不碰**这一行的其它字段（`category` / `color` / `logo` 原样）
4. 退回与确认**互为镜像**（见上）
5. 退回的入参边界：空数组 / 不存在的 id → 0，且**不误伤别的行**
6. 「全部确认无误」一次把剩下的待核对全部置 1 且幂等

⚠️ **基线旧记的「23 项」与实测对不上**：HEAD 版实测 **21** 条 `check()`（本轮 +6 → **27**）。
计数一律以实跑为准（`npm run order:smoke | grep -c "check\|✓"` 或直接数脚本里的 `check(` 调用）。
已在基线里标注**口径更正**。

### `verify` 191/187 → **192/188**

新通道 `order-reopen-corrected` +1 ⇒ preload 暴露键 **192** / types 声明 **192** / 主进程注册通道 **188**。

### 变异复核 **13/13** 全部被抓住

逐条把实现改坏、确认对应断言真的变红（含 M13 = handler 通道名写错 ⇒ `verify` 红）。
收工 `grep -rn MUTANT src/ scripts/ tests/` **无残留**。

⚠️ 变异脚本自身踩了三次故障（都不是产品缺陷，记下来免得下次当"产品坏了"排查）：
① `spawnSync` 直跑时 vite/electron 的换行刷新会交错 stdout ⇒ `out.includes('built in')` 判失败，
13 条全报"build 失败"（**假故障**）⇒ 改成一**前**台跑一遍确认无误、再逐条变异；
② M11/M12 的 patch 目标字符串写错（漏前导缩进 / 把 `.run(...list)` 换成 `.run( list)`）⇒ "命中 0 次"或留下非法代码；
③ M12 变异体**编译不过**（`dbRun(…, ...list)` 类型错）⇒ `order:smoke` 报 `error TS2345`，脚本却读成
"0 条失败 ⇒ 假守卫" ⇒ 改参数形状正确 + 在变异脚本里加「工具没跑起来（`error TS` / `Command failed`）就判失败」的守卫。

## 通用结论（可跨轮复用）

1. **"能力是单向的"是一类独立的缺口** —— 它与"功能坏了"症状完全不同：界面全绿、数据也写对了，
   只是**没有回头路**。发现它的方法不是看代码，而是问一句「用户做错了这一步，怎么改？」
   本轮答案是"屏幕上看不到那批行、也回不去"。同类的还有：已确认/已提交/已归档/已忽略。
2. **补一条反向能力时，先问"正反两件事是不是同一条规矩"** ——
   退回与确认都是"点名即写目标值"，于是校验、入参边界、SQL 形状可以完全对称；
   但**对称不等于都做** —— 批量确认有列表兜底，批量退回不可逆，两者刻意不对称。
3. **同一份视图的两个范围，取数口径要一起审** —— 只有"分页那一路"跟着范围换，
   计数与外部数据源（产品库）**不换**；换错了的症状是"切过去才知道有多少"或"两个数互相矛盾"。
4. **只读格与可编辑格必须是两种形状** —— 已核对范围的颜色/归属款换成纯文本（不是 `disabled` 的输入框），
   让"这里改不了、要退回才能改"在屏幕上一眼可见。
5. ⭐**夹具的两个取值必须不同**（P-46 款色「黑」/订单色「灰」）——
   两个值相同 ⇒ 优先级断言恒绿。这与 `2026-10-11-purchase-image-by-size.md` 的
   "假桥给所有输入同一个输出是最隐蔽的空转"是同一类错误。

## 收工门禁（逐条单看退出码）

`tsc -p tsconfig.electron.json` ✅ · `vue-tsc --noEmit` ✅ · `verify`「✅ IPC 契约一致」（192 / 192 / 188）·
`verify:docs`「✅ 无悬空引用」· `vitest run` **689 passed (37 files)** · `lint` **0 errors**（479 warnings，与基线同性质）·
`build` ✅ · `today:ui` **238** · `goods:ui` **271 ×3 ALL PASS** · `order:smoke` 全部通过 · `order-profit:ui` ALL PASS ·
`purchase:xlsx:smoke` 全部通过（⚠️ 需 `env -u ELECTRON_RUN_AS_NODE`）· `ipc:shape:smoke` **37 项通过**（同上）·
`plugins:island:smoke` **4/4 岛 + 设置贡献 + 重启恢复**通过（⚠️ 需 vite dev server 在跑，且起它与跑它在同一次命令调用里）。

见 `CHANGELOG.md` 同日条目 · `docs/plans/DAILY_SHIPPING_FLOW_PLAN.md` §6 S9c 执行记录。
