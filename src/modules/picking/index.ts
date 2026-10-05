import PickingView from './PickingView.vue';
import { meta } from './meta';
import type { ModuleDefinition } from '@/core/types';

// 模块定义（registry 动态 import 后的默认导出）。
// 取数：订单行投影 + 结算件数 + 缩略图 —— 全部经 core 服务（`@/core/services/ipc`）。
const definition: ModuleDefinition = {
  meta,
  view: PickingView,
};

export default definition;