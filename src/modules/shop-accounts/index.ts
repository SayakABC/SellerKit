import MasterDataView from './MasterDataView.vue';
import { meta } from './meta';
import type { ModuleDefinition } from '@/core/types';

// 模块定义（registry 动态 import 后的默认导出）。
// 取数与写入全部经 `@/core/services/ipc` 的既有通道（shop-accounts / company / shop / mail 域），零新 IPC。
// 设置面板另见同目录 `settings.ts`（由 vite.config.ts 生成 loader 贡献给宿主设置中心）。
const definition: ModuleDefinition = {
  meta,
  view: MasterDataView,
};

export default definition;
