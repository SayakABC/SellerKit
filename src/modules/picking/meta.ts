import type { ModuleMeta } from '@/core/types';

// 「拣货」：选一批**未发货**订单 → 按 **SKU（款 × 色 × 码）** 汇总"要拣什么、各几件、图与供应商在哪" →
// 可导出 xlsx 交给仓库/自己照着拣。
//
// 为什么做成**内建模块**而不是岛（与「订单利润」同一决策）：走渲染层核心最快、**零发版**，
// 不用经过岛的 domains/actions 判定；等要交给岛消费时，再把 db 能力域 op 与岛声明一起发版（P5）。
export const meta: ModuleMeta = {
  id: 'picking',
  name: '拣货',
  icon: 'box',
  order: 4,
};