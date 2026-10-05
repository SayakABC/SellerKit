import GoodsView from './GoodsView.vue';
import { meta } from './meta';
import type { ModuleDefinition } from '@/core/types';

// 模块定义（registry 动态 import 后的默认导出）。
// 取数与写入全部经 core 服务（product 域通道），零新 IPC。
const definition: ModuleDefinition = {
  meta,
  view: GoodsView,
};

export default definition;
