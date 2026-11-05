import OrderCostView from './OrderCostView.vue';
import { meta } from './meta';
import type { ModuleDefinition } from '@/core/types';

// 模块定义（registry 动态 import 后的默认导出）。
// 取数全部经 core 服务：订单行 / 克重 / 成本走 ipc，运价表走 storage（见视图内的过渡说明）。
const definition: ModuleDefinition = {
  meta,
  view: OrderCostView,
};

export default definition;