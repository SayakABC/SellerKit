// extensions/ae-profit/src/index.ts
// 「利润追踪」模块定义（M0）：订单明细 + 收支汇总。数据源为主进程 SQLite（ae_* 表），
// 经语义化 IPC（ae-* 通道）读取；入站采集走 localhost 接收端（electron/ae-receiver.ts）。

import type { ModuleDefinition } from '@/core/types';
import { meta } from './meta';
import AeProfitView from './AeProfitView.vue';

const definition: ModuleDefinition = {
  meta,
  view: AeProfitView,
};

export default definition;
