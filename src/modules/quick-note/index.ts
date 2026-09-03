import QuickNoteView from './QuickNoteView.vue';
import { meta } from './meta';
import type { ModuleDefinition } from '@/core/types';

// 模块定义：注册表动态 import 后得到的默认导出。
// 仅依赖 core 服务（storage / toast），演示业务模块的可插拔与隔离。
const definition: ModuleDefinition = {
  meta,
  view: QuickNoteView,
};

export default definition;
