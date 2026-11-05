import TodayView from './TodayView.vue';
import { meta } from './meta';
import type { ModuleDefinition } from '@/core/types';

// 模块定义（registry 动态 import 后的默认导出）。
// 取数：两个订单投影 + 克重/成本/运价的存在性检查 + 拣货汇总 —— 全部经 core 服务。
const definition: ModuleDefinition = {
  meta,
  view: TodayView,
};

export default definition;