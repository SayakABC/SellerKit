// extensions/order-insight/src/index.ts
// 「订单归类」模块定义：导入订单 Excel → 主图下载 → 指纹查重 → AI 识别 → 归类汇总。

import type { ModuleDefinition } from '@/core/types';
import { meta } from './meta';
import OrderInsightView from './OrderInsightView.vue';

const definition: ModuleDefinition = {
  meta,
  view: OrderInsightView,
};

export default definition;
