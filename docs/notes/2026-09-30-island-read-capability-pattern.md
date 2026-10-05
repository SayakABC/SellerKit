# 给 UI 岛加「读数据」能力的正确形态：宿主只读域 + 复用渲染层纯函数

**结论**：给 UI 岛新增"读业务数据"能力时，**不要**在岛里重写聚合口径，也**不要**新开 IPC 通道 ——
在 `src/core/plugin/host.ts` 的 `DB_OPS` 里加一个**只读域**，op 内部 `await import('@/lib/...')`
复用渲染层那套纯函数（`host.ts` 跑在**渲染进程**，能直接 import `@/lib/*`），一次办完"取数 + 汇总 + 口径"。

**为什么**：岛与宿主是两套产物，口径在两边各写一份**必然漂移**（拣货单少一件就是少发一件货）。
把口径留在 `src/lib/`（已被 vitest 覆盖）并让域 op 调它，岛侧只剩渲染 ⇒ 一处口径、零新通道、零预算消耗。

## 取证

> ⚠️ **2026-09-30 晚订正**：本条原来举的落地实例是 `DB_OPS.picking.groups`（P5 为 order-insight 岛的
> 「拣货」页签所开）。该页签同日被 **C2/M3** 判为"入口冗余"并**发布前撤回**，域与守卫一并删除
> ⇒ **实例换人、结论不变**。下面已改指现役实例；那条"守卫必须先剥注释"的踩坑仍然有效（已固化在
> `pluginTriage` 同族断言里：岛内不得自算口径，先剥注释再扫）。

- 现役落地实例（同一个形态，域 op 内 `await import('@/lib/…')` 复用渲染层纯函数）：
  `shipping-rate`（`quote` 系列 → `@/lib/shipRate*`）、`product`（`importProducts` → `@/lib/productImport`）、
  `excel-copy`（`applyRules` → `@/lib/fieldProcessor`）；外部契约零新增（**IPC 通道数不变**）。
- 已撤回的实例（留作教训）：`DB_OPS.picking.groups` → `@/lib/picking`；它的接线守卫
  `tests/orderInsightPicking.spec.ts` 曾断言**岛里不得出现** `bucketOfStatus` / `parseRowQty` /
  `settleQty` / `aggregatePicking`（口径实现只能在宿主）—— 这类断言**必须先剥注释**，
  否则命中域上方注释里那句 `await import('@/lib/picking')` 而恒绿（**变异测试**抓出来的：
  把真调用换成自算，断言照样通过）。这一形制现在的现役同族在 `pluginTriage`：运费岛的"岛内不自行套费率算式"、
  产品库/订单归类的"岛内不打包 xlsx"、多岛的"无 eval/new Function"。
- 岛侧验证链（手写岛无构建、无类型门禁）：`node --check` → 接线守卫（扫描型）→
  假桥无头冒烟（如 `npm run shipping-rate:ui`）→ 真机 `npm run plugins:island:smoke`。

## 两个连带结论（同批）

1. **岛侧改任何文案/界面 = 一次完整发版**（升版本 → `publish-plugin.js` → 同步本机插件目录 → **重启宿主**）。
   评估"改文案"这类小事的成本时必须按发版算，并把多个岛侧改动**攒成一批**。
2. **能力域 op 与"页面入口"是两件事**：能力可复用，**入口必须唯一**。
   当时的实例是"拣货能力有两个入口" → 2026-09-30 按 **C2/M3** 定了：只留内建「拣货」页，
   岛内页签删掉、连它专用的 `picking` 域也一起删（**没有消费者的能力域就是死物**）。
   ⇒ 反向提醒：**开一个只为一处 UI 服务的域 op 之前，先问"这个入口会不会被判冗余"** ——
   会的话，宁可不做（本次是"代码写完、守卫写完、发布前撤回"，白做一轮）。

> 关联：`docs/plans/PICKING_PLAN.md` §3.3（两条刻意决策与反证）、`docs/plans/UX_POLISH_PLAN.md` §2 P0/P1、
> `AGENTS.md` §1.8（域/权限门）、红线 23（岛 id 不得登记进构建预设）。