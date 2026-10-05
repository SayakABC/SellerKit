import type { ModuleMeta } from '@/core/types';

// 「今天」：**首页工作台** —— 一眼看到"现在该干什么"，每张卡一个动作。
//
// 为什么要有它（`docs/plans/RESTRUCTURE_PLAN.md` §3）：产品原本是"六个能各自干活的工具并排放着"，
// 新用户打开只看到三个入口、其中两个还是空态。工作台把"工具集合"变成"一件事"：
//   待拣多少 → 生成清单；钱算不算得准（缺什么）→ 去看缺在哪；订单从哪来 → 去导入/采集。
//
// 设计原则（用户 2026-09-30）：**只呈现"现状 + 一个可点的下一步"**，不在这一页做计算 ——
// 数字的**算法**仍只有一处（`src/lib/orderCost.ts` / `src/lib/picking.ts`），这里只做"有没有/多少"的**存在性检查**。
export const meta: ModuleMeta = {
  id: 'today',
  name: '今天',
  icon: 'sparkles',
  order: 1,
};