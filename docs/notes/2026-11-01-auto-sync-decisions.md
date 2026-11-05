# 开机自动同步：三条判定顺序 + 一条日志口径

> 施工落点：`electron/schedulerPlan.ts`（判定层纯函数）/ `electron/scheduler.ts`（编排层）。
> 计划：`docs/plans/MANGO_INGEST_AND_POD_PLAN.md` M5（T5-1~T5-6）。

## 结论

1. **判定层 / 编排层必须分开**。判据（"今天同步过没有 / 该不该开浏览器 / 该发哪条通知"）是纯函数，
   可以被 vitest 逐条钉住；副作用（弹浏览器 / 弹通知 / 挂 5 分钟计时器）在 CI 里跑不了。
   跑不了的东西不能当判据 —— 否则"自动化没坏"只能靠人记得去看通知。
2. **`decideAutoSync` 先判"一天上限"、再判"今天已同步"。** 顺序反过来，超过 3 次之后原因会变成
   "今天已同步"，而真相是"补跑用完了"。两个原因要做的事完全不同（一个去查采集，一个等明天）。
   `reason` 永不为空 —— 通知里要原样显示。
3. **只有 `source='startup' AND action='open'` 计入"今天补跑了几次"。** `already_done` / `give_up` /
   `no_push` / `offline` 都写日志（要能查），但不占额度；用户手点的「立即同步」（`manual`）也不挤占自动额度。
4. **通知三态的顺序不能反**：`autoSyncNotice()` 里 **"抓 0 条但总数 > 0"必须排在 `ok===false` 之前**。
   反了就把红线 1 退化成一条"同步失败"，用户会去重启，而真正原因是登录过期 / 扩展没生效。
   `fetched===0 && totalItems===0` 才是真没单（给成功通知「今天没有待发货」）。
5. **`day_key` 必须用本地时区**（`schedulerPlan.localDayKey`，与 `src/lib/localDay.ts` 刻意第二份实现：
   两份都很小、互相 import 不值得）。`toISOString().slice(0,10)` 在东八区会让"今天 08:00 同步过"算成昨天，
   "一天一次"就变成一天两次。

## 取证

- 单测：`tests/schedulerPlan.spec.ts` **24 例**，其中三条是上面这些顺序判据的"咬人"用例：
  · 上限用尽 vs 今天已同步的优先级；
  · `fetched=0 && totalItems>0` 必须出 `zero`（不是 `failure`）；
  · `new Date('2026-11-01T16:30:00Z') → '2026-11-02'`（东八区的跨日回归）。
- 冒烟：`npm run scheduler:smoke` **12 项** —— 空库单域建表 / 列形状 / 幂等 / `day_key` 默认本地今天 /
  只数 startup+open / manual 不挤占 / 昨天不计 / attempts 到上限后 `give_up` 对齐 / reason 截 500 /
  脏输入不抛 / 只建本域表。
- 日志表：`sk_auto_sync_log`（进 `scripts/db-inventory.cjs` 的域文件清单与表格用途文案 ——
  漏登记会让整张表在清单里**静默消失**）。

## 还没做的

- **T5-6 四场景手工演练**（断网重启 / 登录过期 / 扩展未装 / Chrome 没开）没实跑，步骤与期望写在计划 M5 施工记录里。
  判据是"四种都能看到明确原因，没有一种是静默没数据"。
- 托盘与自启只能在真机上验（关窗不退出 / 重启后进程在跑而窗口没弹出来）。
