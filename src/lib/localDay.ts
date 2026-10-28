// src/lib/localDay.ts
// 「本机今天」的唯一实现（`yyyy-mm-dd`，**本地时区**）。
//
// 为什么单拎一处：渲染层有三处都在问"今天是哪天"，各自实现过一版 ——
//   · `goods/productIo.todayKey` —— 手工进价的**生效日**（口径 = 录入当日）；
//   · `today/purchase.localDay`  —— 对账时间窗的分段控件（全部/今天/本月…）；
//   · `today/**`（2026-10-11 新增）—— 「发货台」的**导入日**过滤（订单取数只取今天导进来的那批）。
// 三者问的是同一件事，实现必须同一份：各写各的必然在"补零 / 时区"上分叉，
// 而"日期差一天"是本仓最难查的一类 bug —— 数字看着都对，只是不是同一天。
//
// ⚠️ **不用 `toISOString().slice(0,10)`**：那是 UTC 日期。东八区下午 8 点之后跑，
//    它会返回**前一天** —— 于是"今晚导的单"被当成"昨天导的"，整天的过滤静默错位。
// ⚠️ 主进程侧（CJS 构建、不 import `src/`）需要同一口径时，只能**刻意再写一份**——
//    原先 `electron/manual-costs.ts` 就有一份同名 `todayKey`（该模块已随 C2 删表删除）；
//    现在主进程侧的日期归一在 `electron/order-db.ts` 的迁移里是冻结副本。
export function localDayKey(d: Date = new Date()): string {
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
