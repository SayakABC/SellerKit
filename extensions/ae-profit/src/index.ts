// extensions/ae-profit/src/index.ts
// 「利润追踪」模块定义（M1）：利润统计 v1（日月趋势 / TOP / 费用构成 / 成本覆盖率）+ 订单明细（M0）
// + 成本衔接（拿货对账快照 → ae_cost_map）+ 汇率维护。数据源为主进程 SQLite（ae_* / ae_rates / ae_cost_map），
// 经语义化 IPC（ae-* / purchase-cost-snapshot 通道）读写；入站采集走 localhost 接收端（electron/ae-receiver.ts）。

import type { ModuleDefinition } from '@/core/types';
import { meta } from './meta';
import AeProfitView from './AeProfitView.vue';

const definition: ModuleDefinition = {
  meta,
  view: AeProfitView,
};

export default definition;
